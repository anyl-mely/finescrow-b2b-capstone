-- 1. Khởi tạo 2 Doanh nghiệp (Buyer & Seller), 2 Ví, 1 Hợp đồng và 1 Milestone trị giá 1000.0000 USD
WITH ins_buyer AS (
  INSERT INTO organizations (id, org_code, legal_name)
  VALUES ('11111111-1111-1111-1111-111111111111', 'ORG-BUYER-01', 'Alpha Importers Co.')
  RETURNING id
),
ins_seller AS (
  INSERT INTO organizations (id, org_code, legal_name)
  VALUES ('22222222-2222-2222-2222-222222222222', 'ORG-SELLER-02', 'Beta Manufacturing Ltd.')
  RETURNING id
),
ins_wallets AS (
  INSERT INTO escrow_wallets (id, organization_id, available_balance, locked_balance)
  VALUES
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 5000.0000, 1000.0000),
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 2000.0000, 0.0000)
),
ins_contract AS (
  INSERT INTO escrow_contracts (id, contract_code, status, total_amount, metadata)
  VALUES (
    'cccccccc-cccc-cccc-cccc-cccccccccccc',
    'ESC-2026-MAIN',
    'FUNDED',
    1000.0000,
    '{"incoterms": "FOB", "sla_days": 14, "inspection_Required": true}'::jsonb
  )
)
INSERT INTO contract_milestones (id, contract_id, milestone_code, amount, status)
VALUES (
  'dddddddd-dddd-dddd-dddd-dddddddddddd',
  'cccccccc-cccc-cccc-cccc-cccccccccccc',
  'MS-BATCH-01',
  1000.0000,
  'LOCKED'
);

-- 2. [Mục 4.3 & Cổng 4] Bơm 500.000 dòng bút toán lịch sử để đo hiệu năng Index
INSERT INTO ledger_entries (wallet_id, contract_id, entry_type, amount, reference_code, created_at)
SELECT
  CASE WHEN g % 2 = 0
    THEN 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid
    ELSE 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid
  END,
  'cccccccc-cccc-cccc-cccc-cccccccccccc'::uuid,
  CASE WHEN g % 2 = 0 THEN 'DEBIT' ELSE 'CREDIT' END,
  ((g % 50) + 10)::numeric(19,4),
  'HIST-TX-' || g,
  NOW() - (g || ' seconds')::interval
FROM generate_series(1, 500000) AS g;

ANALYZE ledger_entries;
ANALYZE escrow_contracts;

-- 3. [Mục 4.3] Giải phẫu hiệu năng bằng EXPLAIN (ANALYZE, BUFFERS) trên 500.000 dòng
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, entry_type, amount, reference_code, created_at
FROM ledger_entries
WHERE wallet_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
ORDER BY created_at DESC
LIMIT 10;

-- 4. [Mục 4.2] Báo cáo phân tích bằng CTE (WITH) + Window Functions (SUM OVER & LAG)
WITH recent_wallet_tx AS (
  SELECT
    reference_code,
    entry_type,
    amount,
    created_at,
    CASE WHEN entry_type = 'CREDIT' THEN amount ELSE -amount END AS signed_amount
  FROM ledger_entries
  WHERE wallet_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
  ORDER BY created_at DESC
  LIMIT 5
)
SELECT
  reference_code,
  entry_type,
  amount,
  LAG(amount, 1, 0.0000) OVER (ORDER BY created_at) AS prev_tx_amount,
  SUM(signed_amount) OVER (ORDER BY created_at ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running_net_change
FROM recent_wallet_tx
ORDER BY created_at DESC;

-- 5. [Mục 4.3] Xử lý triệt để N+1 Query bằng LEFT JOIN + jsonb_agg trong 1 truy vấn duy nhất
SELECT
  c.contract_code,
  c.status,
  c.total_amount,
  COALESCE(
    jsonb_agg(
      jsonb_build_object('milestone_code', m.milestone_code, 'amount', m.amount, 'status', m.status)
    ) FILTER (WHERE m.id IS NOT NULL),
    '[]'::jsonb
  ) AS milestones
FROM escrow_contracts c
LEFT JOIN contract_milestones m ON m.contract_id = c.id
WHERE c.status IN ('FUNDED', 'DISPUTED')
GROUP BY c.id;