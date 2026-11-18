import express, { type Request, type Response, type NextFunction } from 'express';
import pg from 'pg';
import { Redis } from 'ioredis';
import { Queue, Worker } from 'bullmq';
import {
    AppError,
    ReleaseMilestoneSchema,
    createRateLimiter,
    globalErrorHandler,
    requireAuth,
    validateBody,
} from './middlewares/security.middleware.js';
import { EscrowPgRepository } from './repositories/escrow.pg.repository.js';
import { EscrowV1Service } from './services/escrow.v1.service.js';

export function buildV1Infrastructure() {
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

    const auditQueue = new Queue('finescrow-audit-queue', { connection: redis });

    const auditWorker = new Worker(
        'finescrow-audit-queue',
        async (job) => {
            console.log(`[BullMQ Worker] Đã xuất chứng từ kiểm toán cho giao dịch: ${job.data.referenceCode}`);
        },
        { connection: redis }
    );

    const repository = new EscrowPgRepository(pool);
    const escrowService = new EscrowV1Service(repository, redis, auditQueue);

    const app = express();
    app.use(express.json());

    // [Mục 5.5] Bộ đếm Observability chuẩn Prometheus
    let httpRequestsTotal = 0;
    let escrowSettlementsTotal = 0;

    app.use((_req: Request, _res: Response, next: NextFunction) => {
        httpRequestsTotal += 1;
        next();
    });

    // [Mục 5.1] Đặc tả OpenAPI 3.1 Spec
    app.get('/api/v1/openapi.json', (_req: Request, res: Response) => {
        res.json({
            openapi: '3.1.0',
            info: { title: 'FinEscrow B2B API', version: '1.0.0' },
            paths: {
                '/api/v1/escrows/{id}': { get: { summary: 'Xem chi tiết hợp đồng (Hard RBAC + Cache-Aside)' } },
                '/api/v1/escrows/release': { post: { summary: 'Giải ngân Milestone nguyên tử (Idempotent)' } },
            },
        });
    });

    // [Mục 5.5] Endpoint xuất Metrics cho Prometheus / Grafana
    app.get('/metrics', (_req: Request, res: Response) => {
        res.setHeader('Content-Type', 'text/plain; version=0.0.4');
        res.send(
            `# HELP finescrow_http_requests_total Tổng số request HTTP\n` +
            `# TYPE finescrow_http_requests_total counter\n` +
            `finescrow_http_requests_total ${httpRequestsTotal}\n` +
            `# HELP finescrow_settlements_total Tổng số giao dịch giải ngân thành công\n` +
            `# TYPE finescrow_settlements_total counter\n` +
            `finescrow_settlements_total ${escrowSettlementsTotal}\n`
        );
    });

    const sensitiveLimiter = createRateLimiter(5, 60_000);

    // Tầng Route + Controller 1: Xem chi tiết hợp đồng
    app.get(
        '/api/v1/escrows/:id',
        requireAuth,
        async (req: Request, res: Response, next: NextFunction) => {
            try {
                const contractId = req.params.id;
                const callerOrgId = req.auth?.organizationId;
                if (typeof contractId !== 'string' || !contractId || !callerOrgId) {
                    throw new AppError(400, 'BAD_REQUEST', 'Thiếu thông tin định danh hợp đồng hoặc tổ chức.');
                }
                const result = await escrowService.getContractDetails(contractId, callerOrgId);
                res.status(200).json(result);
            } catch (err) {
                next(err);
            }
        }
    );

    // Tầng Route + Controller 2: Giải ngân Milestone
    app.post(
        '/api/v1/escrows/release',
        sensitiveLimiter,
        requireAuth,
        validateBody(ReleaseMilestoneSchema),
        async (req: Request, res: Response, next: NextFunction) => {
            try {
                const idempotencyKey = req.headers['idempotency-key'];
                if (typeof idempotencyKey !== 'string' || idempotencyKey.trim().length < 4) {
                    throw new AppError(400, 'MISSING_IDEMPOTENCY_KEY', 'Bắt buộc gửi kèm header Idempotency-Key.');
                }
                const callerOrgId = req.auth?.organizationId;
                if (!callerOrgId) {
                    throw new AppError(401, 'UNAUTHORIZED', 'Không xác định được tổ chức từ JWT.');
                }

                const { contractId, milestoneId } = req.body as { contractId: string; milestoneId: string };
                const settlement = await escrowService.releaseMilestone({
                    contractId,
                    milestoneId,
                    callerOrgId,
                    idempotencyKey: idempotencyKey.trim(),
                });

                escrowSettlementsTotal += 1;
                res.status(200).json(settlement);
            } catch (err) {
                next(err);
            }
        }
    );

    app.use(globalErrorHandler);

    async function closeAll() {
        await auditWorker.close();
        await auditQueue.close();
        await redis.quit();
        await pool.end();
    }

    return { app, pool, redis, closeAll };
}