import pg from 'pg';

const { Pool } = pg;

const pool = new Pool({
    connectionString: 'postgresql://finescrow_admin:finescrow_secret_2026@localhost:5432/finescrow_db',
    max: 15,
});

const MILESTONE_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const BUYER_WALLET_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const SELLER_WALLET_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const CONTRACT_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

async function attemptReleaseMilestone(workerIndex: number): Promise<string> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // [Mục 4.4] KHÓA BI QUAN (PESSIMISTIC ROW LOCKING):
        // FOR UPDATE khóa cứng dòng milestone này cho đến khi Transaction hiện tại COMMIT hoặc ROLLBACK
        const msRes = await client.query<{ id: string; status: string; amount: string }>(
            `SELECT id, status, amount
       FROM contract_milestones
       WHERE id = $1
       FOR UPDATE`,
            [MILESTONE_ID]
        );

        const milestone = msRes.rows[0];
        if (!milestone) {
            await client.query('ROLLBACK');
            return `[Worker #${workerIndex}] BLOCKED: Không tìm thấy Milestone`;
        }

        if (milestone.status !== 'LOCKED') {
            await client.query('ROLLBACK');
            return `[Worker #${workerIndex}] REJECTED (Chống Race Condition): Milestone đã ở trạng thái ${milestone.status}`;
        }

        // Khóa tiếp ví Buyer để trừ locked_balance an toàn (chống âm quỹ nhờ cả khóa dòng lẫn CHECK constraint)
        await client.query(
            `UPDATE escrow_wallets
       SET locked_balance = locked_balance - $1, updated_at = NOW()
       WHERE id = $2`,
            [milestone.amount, BUYER_WALLET_ID]
        );

        // Cộng available_balance cho ví Seller
        await client.query(
            `UPDATE escrow_wallets
       SET available_balance = available_balance + $1, updated_at = NOW()
       WHERE id = $2`,
            [milestone.amount, SELLER_WALLET_ID]
        );

        // Ghi cặp bút toán Sổ cái kép (DEBIT ví Buyer, CREDIT ví Seller)
        await client.query(
            `INSERT INTO ledger_entries (wallet_id, contract_id, entry_type, amount, reference_code)
       VALUES
         ($1, $3, 'DEBIT', $4, $5),
         ($2, $3, 'CREDIT', $4, $5)`,
            [BUYER_WALLET_ID, SELLER_WALLET_ID, CONTRACT_ID, milestone.amount, `RACE-TEST-W${workerIndex}`]
        );

        // Đánh dấu Milestone đã giải ngân
        await client.query(
            `UPDATE contract_milestones
       SET status = 'RELEASED', released_at = NOW()
       WHERE id = $1`,
            [MILESTONE_ID]
        );

        await client.query('COMMIT');
        return `[Worker #${workerIndex}] SUCCESS: Đã giải ngân thành công ${milestone.amount} USD!`;
    } catch (err) {
        await client.query('ROLLBACK');
        const msg = err instanceof Error ? err.message : String(err);
        return `[Worker #${workerIndex}] DB_ERROR: ${msg}`;
    } finally {
        client.release();
    }
}

async function runConcurrencySimulation() {
    console.log('=== BẮT ĐẦU BẮN 10 REQUEST GIẢI NGÂN ĐỒNG THỜI (MỤC 4.4) ===');

    const tasks = Array.from({ length: 10 }, (_, idx) => attemptReleaseMilestone(idx + 1));
    const results = await Promise.all(tasks);

    for (const line of results) {
        console.log(line);
    }

    const walletCheck = await pool.query<{ org_id: string; available_balance: string; locked_balance: string }>(
        `SELECT organization_id AS org_id, available_balance, locked_balance
     FROM escrow_wallets
     ORDER BY organization_id`
    );

    console.log('\n=== KIỂM TRA SỐ DƯ VÍ SAU CÙNG (KHÔNG BAO GIỜ ÂM TIỀN) ===');
    console.table(walletCheck.rows);

    await pool.end();
}

runConcurrencySimulation();