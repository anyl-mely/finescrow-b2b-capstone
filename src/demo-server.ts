import path from 'node:path';
import express, { type Request, type Response, type NextFunction } from 'express';
import pg from 'pg';
import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import {
    AppError,
    globalErrorHandler,
    requireAuth,
    signJwtToken,
} from './middlewares/security.middleware.js';
import { EscrowPgRepository } from './repositories/escrow.pg.repository.js';
import { EscrowV1Service } from './services/escrow.v1.service.js';
import { RagV2Service, maskSensitivePii } from './services/rag.v2.service.js';
import { AutonomousDisputeAgent, FinEscrowMcpServer } from './services/agent.v3.service.js';

const CONTRACT_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const MILESTONE_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const BUYER_ORG_ID = '11111111-1111-1111-1111-111111111111';
const SELLER_ORG_ID = '22222222-2222-2222-2222-222222222222';
const OUTSIDER_ORG_ID = '99999999-9999-9999-9999-999999999999';

const pool = new pg.Pool({
    connectionString:
        process.env.DATABASE_URL ??
        'postgresql://finescrow_admin:finescrow_secret_2026@localhost:5432/finescrow_db',
});

const redis = new Redis({
    host: process.env.REDIS_HOST ?? '127.0.0.1',
    port: Number(process.env.REDIS_PORT ?? 6379),
    maxRetriesPerRequest: null,
});

const auditQueue = new Queue('finescrow-demo-queue', { connection: redis });
const repo = new EscrowPgRepository(pool);
const escrowV1 = new EscrowV1Service(repo, redis, auditQueue);
const ragV2 = new RagV2Service(pool);
const agentV3 = new AutonomousDisputeAgent(pool, ragV2, escrowV1);
const mcpServer = new FinEscrowMcpServer(ragV2);

const app = express();
app.use(express.json());
app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Access-Control-Allow-Origin', 'http://localhost:5173');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Idempotency-Key');
    if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
    }
    next();
});
app.use(express.static(path.resolve(process.cwd(), 'public')));

app.get('/', (_req: Request, res: Response) => {
    res.sendFile(path.resolve(process.cwd(), 'public', 'demo.html'));
});

// 1. Cấp JWT giả lập theo vai trò & Reset dữ liệu Demo
app.post('/api/demo/token', (req: Request, res: Response) => {
    const roleInput = (req.body as { persona?: string }).persona;
    if (roleInput === 'SELLER') {
        const { token } = signJwtToken({ userId: 'u-seller', organizationId: SELLER_ORG_ID, role: 'SELLER' });
        res.json({ persona: 'SELLER (Beta Manufacturing)', organizationId: SELLER_ORG_ID, token });
        return;
    }
    if (roleInput === 'OUTSIDER') {
        const { token } = signJwtToken({ userId: 'u-hacker', organizationId: OUTSIDER_ORG_ID, role: 'BUYER' });
        res.json({ persona: 'OUTSIDER (Doanh nghiệp lạ)', organizationId: OUTSIDER_ORG_ID, token });
        return;
    }
    const { token } = signJwtToken({ userId: 'u-buyer', organizationId: BUYER_ORG_ID, role: 'BUYER' });
    res.json({ persona: 'BUYER (Alpha Importers)', organizationId: BUYER_ORG_ID, token });
});

app.post('/api/demo/reset', async (_req: Request, res: Response, next: NextFunction) => {
    try {
        await redis.flushall();
        await pool.query(`DELETE FROM agent_checkpoints`);
        await pool.query(`DELETE FROM contract_knowledge_chunks`);
        await pool.query(
            `INSERT INTO contract_participants (contract_id, organization_id, role)
       VALUES ($1, $2, 'BUYER'), ($1, $3, 'SELLER') ON CONFLICT DO NOTHING`,
            [CONTRACT_ID, BUYER_ORG_ID, SELLER_ORG_ID]
        );
        await pool.query(
            `UPDATE escrow_wallets SET available_balance = 5000.0000, locked_balance = 1000.0000 WHERE organization_id = $1`,
            [BUYER_ORG_ID]
        );
        await pool.query(
            `UPDATE escrow_wallets SET available_balance = 2000.0000, locked_balance = 0.0000 WHERE organization_id = $1`,
            [SELLER_ORG_ID]
        );
        await pool.query(
            `UPDATE contract_milestones SET status = 'LOCKED', released_at = NULL WHERE id = $1`,
            [MILESTONE_ID]
        );
        await pool.query(`UPDATE escrow_contracts SET status = 'FUNDED' WHERE id = $1`, [CONTRACT_ID]);
        res.json({ message: 'Đã khôi phục toàn bộ Ví, Hợp đồng, Redis Cache và Checkpoints về trạng thái ban đầu.' });
    } catch (err) {
        next(err);
    }
});

app.get('/api/demo/state', async (_req: Request, res: Response, next: NextFunction) => {
    try {
        const wallets = await pool.query(
            `SELECT o.org_code, w.available_balance::text, w.locked_balance::text
       FROM escrow_wallets w JOIN organizations o ON o.id = w.organization_id ORDER BY o.org_code`
        );
        const contract = await pool.query(
            `SELECT c.contract_code, c.status AS contract_status, m.milestone_code, m.status AS milestone_status, m.amount::text
       FROM escrow_contracts c JOIN contract_milestones m ON m.contract_id = c.id WHERE c.id = $1`,
            [CONTRACT_ID]
        );
        res.json({ wallets: wallets.rows, contract: contract.rows[0] ?? null });
    } catch (err) {
        next(err);
    }
});

// 2. [GĐ 5 — v1.0] Xem hợp đồng (IDOR + Cache-Aside) & Giải ngân lũy đẳng
app.get('/api/v1/escrows/:id', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
        const contractId = req.params.id;
        const callerOrgId = req.auth?.organizationId;
        if (typeof contractId !== 'string' || !callerOrgId) {
            throw new AppError(400, 'BAD_REQUEST', 'Thiếu định danh hợp đồng hoặc tổ chức.');
        }
        const result = await escrowV1.getContractDetails(contractId, callerOrgId);
        res.json(result);
    } catch (err) {
        next(err);
    }
});

app.post('/api/v1/escrows/release', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
        const idempotencyKey = req.headers['idempotency-key'];
        const callerOrgId = req.auth?.organizationId;
        if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || !callerOrgId) {
            throw new AppError(400, 'BAD_REQUEST', 'Thiếu Idempotency-Key hoặc JWT hợp lệ.');
        }
        const result = await escrowV1.releaseMilestone({
            contractId: CONTRACT_ID,
            milestoneId: MILESTONE_ID,
            callerOrgId,
            idempotencyKey: idempotencyKey.trim(),
        });
        res.json(result);
    } catch (err) {
        next(err);
    }
});

// 3. [GĐ 6 — v2.0] Nạp hợp đồng (PII + Prompt Injection Guard) & Hybrid Search RBAC
app.post('/api/v2/rag/ingest', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { rawText } = req.body as { rawText?: string };
        if (!rawText) throw new AppError(400, 'EMPTY_DOCUMENT', 'Vui lòng nhập nội dung hợp đồng.');
        const maskedPreview = maskSensitivePii(rawText);
        const chunksCreated = await ragV2.ingestContractDocument({
            contractId: CONTRACT_ID,
            rawDocumentText: rawText,
        });
        res.json({ chunksCreated, maskedPreview });
    } catch (err) {
        next(err);
    }
});

app.post('/api/v2/rag/search', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
        const callerOrgId = req.auth?.organizationId;
        const { queryText } = req.body as { queryText?: string };
        if (!callerOrgId || !queryText) throw new AppError(400, 'BAD_REQUEST', 'Thiếu câu truy vấn.');
        const matches = await ragV2.hybridSearchRbac({
            contractId: CONTRACT_ID,
            callerOrgId,
            queryText,
            topK: 3,
        });
        res.json({ matchCount: matches.length, matches });
    } catch (err) {
        next(err);
    }
});

// 4. [GĐ 7 — v3.0] Agent State Machine, Time-Travel, HITL & Audit Log Bất biến
app.post('/api/v3/agent/dispute', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!req.auth) throw new AppError(401, 'UNAUTHORIZED', 'Thiếu JWT.');
        const { threadId, disputeClaim } = req.body as { threadId?: string; disputeClaim?: string };
        const result = await agentV3.runDisputeWorkflow({
            threadId: threadId ?? 'demo-thread-2026',
            jwtContext: req.auth,
            contractId: CONTRACT_ID,
            milestoneId: MILESTONE_ID,
            disputeClaim: disputeClaim ?? 'Giao hàng trễ hạn theo Điều 14.2',
            initialDraftSplit: { buyerPct: 30, sellerPct: 80 },
        });
        res.json(result);
    } catch (err) {
        next(err);
    }
});

app.get('/api/v3/agent/time-travel/:threadId/:step', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { threadId, step } = req.params;
        if (typeof threadId !== 'string' || typeof step !== 'string') {
            throw new AppError(400, 'BAD_REQUEST', 'Tham số không hợp lệ.');
        }
        const snapshot = await agentV3.timeTravelInspect(threadId, Number(step));
        res.json(snapshot);
    } catch (err) {
        next(err);
    }
});

app.post('/api/v3/agent/hitl-approve', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!req.auth) throw new AppError(401, 'UNAUTHORIZED', 'Thiếu JWT.');
        const { threadId, idempotencyKey } = req.body as { threadId?: string; idempotencyKey?: string };
        const result = await agentV3.approveAndResumeHitl({
            threadId: threadId ?? 'demo-thread-2026',
            arbitratorJwt: req.auth,
            idempotencyKey: idempotencyKey ?? `hitl-${Date.now()}`,
        });
        res.json(result);
    } catch (err) {
        next(err);
    }
});

app.get('/api/v3/agent/audit-logs', async (_req: Request, res: Response, next: NextFunction) => {
    try {
        const logs = await pool.query(
            `SELECT tool_name, risk_tier, caller_role, decision_status, created_at
       FROM agent_audit_logs ORDER BY created_at DESC LIMIT 6`
        );
        res.json({ logs: logs.rows, mcpTools: mcpServer.listTools() });
    } catch (err) {
        next(err);
    }
});

app.post('/api/v3/agent/test-immutable-delete', async (_req: Request, res: Response, next: NextFunction) => {
    try {
        await pool.query(`DELETE FROM agent_audit_logs`);
        res.json({ ok: true });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        next(new AppError(403, 'IMMUTABLE_AUDIT_LOG_BLOCKED', message));
    }
});

app.use(globalErrorHandler);

app.listen(3000, () => {
    console.log('FinEscrow Live Web Demo (GĐ 5-7) đang chạy tại: http://localhost:3000');
});