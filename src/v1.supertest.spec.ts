import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildV1Infrastructure } from './app.js';
import { signJwtToken } from './middlewares/security.middleware.js';

const CONTRACT_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const MILESTONE_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const BUYER_ORG_ID = '11111111-1111-1111-1111-111111111111';
const SELLER_ORG_ID = '22222222-2222-2222-2222-222222222222';
const OUTSIDER_ORG_ID = '99999999-9999-9999-9999-999999999999';

describe('Cổng Kiểm Định 5 — FinEscrow v1.0 Enterprise Backend', () => {
    const infra = buildV1Infrastructure();

    const buyerToken = signJwtToken({
        userId: 'user-buyer-1',
        organizationId: BUYER_ORG_ID,
        role: 'BUYER',
    }).token;

    const outsiderToken = signJwtToken({
        userId: 'user-hacker-99',
        organizationId: OUTSIDER_ORG_ID,
        role: 'BUYER',
    }).token;

    beforeAll(async () => {
        await infra.redis.flushall();
        // Khôi phục trạng thái chuẩn của hợp đồng, ví và quyền tham gia trước khi chạy test
        await infra.pool.query(
            `INSERT INTO contract_participants (contract_id, organization_id, role)
       VALUES ($1, $2, 'BUYER'), ($1, $3, 'SELLER')
       ON CONFLICT DO NOTHING`,
            [CONTRACT_ID, BUYER_ORG_ID, SELLER_ORG_ID]
        );
        await infra.pool.query(
            `UPDATE escrow_wallets SET available_balance = 5000.0000, locked_balance = 1000.0000 WHERE organization_id = $1`,
            [BUYER_ORG_ID]
        );
        await infra.pool.query(
            `UPDATE contract_milestones SET status = 'LOCKED', released_at = NULL WHERE id = $1`,
            [MILESTONE_ID]
        );
        await infra.pool.query(`UPDATE escrow_contracts SET status = 'FUNDED' WHERE id = $1`, [CONTRACT_ID]);
    });

    afterAll(async () => {
        await infra.closeAll();
    });

    it('1. Chặn tuyệt đối tấn công IDOR (403 Forbidden) khi doanh nghiệp ngoài cuộc truy cập hợp đồng', async () => {
        const res = await request(infra.app)
            .get(`/api/v1/escrows/${CONTRACT_ID}`)
            .set('Authorization', `Bearer ${outsiderToken}`);

        expect(res.status).toBe(403);
        expect(res.body.error).toBe('FORBIDDEN_IDOR');
    });

    it('2. Vận hành đúng mô hình Redis Cache-Aside (Lần 1 POSTGRES_DB -> Lần 2 REDIS_CACHE)', async () => {
        const firstRes = await request(infra.app)
            .get(`/api/v1/escrows/${CONTRACT_ID}`)
            .set('Authorization', `Bearer ${buyerToken}`);
        expect(firstRes.status).toBe(200);
        expect(firstRes.body.source).toBe('POSTGRES_DB');

        const secondRes = await request(infra.app)
            .get(`/api/v1/escrows/${CONTRACT_ID}`)
            .set('Authorization', `Bearer ${buyerToken}`);
        expect(secondRes.status).toBe(200);
        expect(secondRes.body.source).toBe('REDIS_CACHE');
    });

    it('3. Giải ngân nguyên tử thành công và chặn Idempotency Replay (409 Conflict) khi gửi đúp', async () => {
        const idemKey = 'idem-v1-test-key-001';

        const successRes = await request(infra.app)
            .post('/api/v1/escrows/release')
            .set('Authorization', `Bearer ${buyerToken}`)
            .set('Idempotency-Key', idemKey)
            .send({ contractId: CONTRACT_ID, milestoneId: MILESTONE_ID });

        expect(successRes.status).toBe(200);
        expect(successRes.body.releasedAmount).toBe('1000.0000');

        // Gửi lặp lại đúng Idempotency-Key vừa dùng
        const replayRes = await request(infra.app)
            .post('/api/v1/escrows/release')
            .set('Authorization', `Bearer ${buyerToken}`)
            .set('Idempotency-Key', idemKey)
            .send({ contractId: CONTRACT_ID, milestoneId: MILESTONE_ID });

        expect(replayRes.status).toBe(409);
        expect(replayRes.body.error).toBe('IDEMPOTENT_REPLAY');
    });
});