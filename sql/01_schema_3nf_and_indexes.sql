CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "vector";

DROP TABLE IF EXISTS ledger_entries CASCADE;
DROP TABLE IF EXISTS contract_milestones CASCADE;
DROP TABLE IF EXISTS contract_participants CASCADE;
DROP TABLE IF EXISTS escrow_contracts CASCADE;
DROP TABLE IF EXISTS escrow_wallets CASCADE;
DROP TABLE IF EXISTS organizations CASCADE;

-- 1. Bảng Doanh nghiệp B2B
CREATE TABLE organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_code VARCHAR(32) UNIQUE NOT NULL,
  legal_name VARCHAR(150) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Bảng Ví Ký Quỹ (1-1 với organizations, có CHECK chống âm tiền tuyệt đối)
CREATE TABLE escrow_wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID UNIQUE NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  currency CHAR(3) NOT NULL DEFAULT 'USD',
  available_balance NUMERIC(19, 4) NOT NULL DEFAULT 0.0000,
  locked_balance NUMERIC(19, 4) NOT NULL DEFAULT 0.0000,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_wallet_non_negative CHECK (available_balance >= 0 AND locked_balance >= 0)
);

-- 3. Bảng Hợp Đồng Ký Quỹ (Lưu điều khoản phụ lục trong JSONB)
CREATE TABLE escrow_contracts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_code VARCHAR(50) UNIQUE NOT NULL,
  status VARCHAR(20) NOT NULL CHECK (status IN ('FUNDED', 'DISPUTED', 'RELEASED', 'REFUNDED')),
  total_amount NUMERIC(19, 4) NOT NULL CHECK (total_amount > 0),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Bảng Trung Gian N-N: Các bên tham gia Hợp đồng (BUYER, SELLER, ARBITRATOR)
CREATE TABLE contract_participants (
  contract_id UUID NOT NULL REFERENCES escrow_contracts(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  role VARCHAR(20) NOT NULL CHECK (role IN ('BUYER', 'SELLER', 'ARBITRATOR')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (contract_id, organization_id, role)
);

-- 5. Bảng Các Đợt Thanh Toán (Milestones — 1-N với escrow_contracts)
CREATE TABLE contract_milestones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id UUID NOT NULL REFERENCES escrow_contracts(id) ON DELETE CASCADE,
  milestone_code VARCHAR(50) UNIQUE NOT NULL,
  amount NUMERIC(19, 4) NOT NULL CHECK (amount > 0),
  status VARCHAR(20) NOT NULL CHECK (status IN ('LOCKED', 'DISPUTED', 'RELEASED')),
  released_at TIMESTAMPTZ
);

-- 6. Bảng Sổ Cái Kép (Double-Entry Ledger — Bất biến)
CREATE TABLE ledger_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id UUID NOT NULL REFERENCES escrow_wallets(id) ON DELETE RESTRICT,
  contract_id UUID NOT NULL REFERENCES escrow_contracts(id) ON DELETE RESTRICT,
  entry_type VARCHAR(10) NOT NULL CHECK (entry_type IN ('DEBIT', 'CREDIT')),
  amount NUMERIC(19, 4) NOT NULL CHECK (amount > 0),
  reference_code VARCHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- [Mục 4.3] CHIẾN LƯỢC ĐÁNH CHỈ MỤC (INDEXING STRATEGY)
-- 1. Composite B-Tree Index: Phục vụ lấy sao kê theo ví sắp xếp mới nhất
CREATE INDEX idx_ledger_wallet_created ON ledger_entries (wallet_id, created_at DESC);

-- 2. Partial Index: Chỉ đánh chỉ mục trên các hợp đồng đang mở hoặc đang tranh chấp
CREATE INDEX idx_contracts_active_disputed ON escrow_contracts (created_at DESC)
WHERE status IN ('FUNDED', 'DISPUTED');

-- 3. GIN Index: Phục vụ truy vấn nhanh các thuộc tính bên trong cột JSONB metadata
CREATE INDEX idx_contracts_metadata_gin ON escrow_contracts USING GIN (metadata);