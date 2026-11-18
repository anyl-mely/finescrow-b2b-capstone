import type { Redis } from 'ioredis';
import type { Queue } from 'bullmq';
import { AppError } from '../middlewares/security.middleware.js';
import type {
    ContractDetailsView,
    EscrowPgRepository,
    SettlementResult,
} from '../repositories/escrow.pg.repository.js';

export class EscrowV1Service {
    constructor(
        private readonly repo: EscrowPgRepository,
        private readonly redis: Redis,
        private readonly auditQueue: Queue
    ) { }

    // [Mục 5.4] Mô hình Redis Cache-Aside có gắn mã Doanh nghiệp để bảo toàn RBAC
    async getContractDetails(
        contractId: string,
        callerOrgId: string
    ): Promise<{ source: 'REDIS_CACHE' | 'POSTGRES_DB'; data: ContractDetailsView }> {
        const cacheKey = `escrow:contract:${contractId}:org:${callerOrgId}`;
        const cached = await this.redis.get(cacheKey);

        if (cached) {
            return {
                source: 'REDIS_CACHE',
                data: JSON.parse(cached) as ContractDetailsView,
            };
        }

        const details = await this.repo.getContractForParticipant(contractId, callerOrgId);
        await this.redis.set(cacheKey, JSON.stringify(details), 'EX', 60);

        return {
            source: 'POSTGRES_DB',
            data: details,
        };
    }

    // [Mục 5.4] Khóa lũy đẳng Idempotency Key + Giao dịch nguyên tử + Hàng đợi BullMQ
    async releaseMilestone(params: {
        contractId: string;
        milestoneId: string;
        callerOrgId: string;
        idempotencyKey: string;
    }): Promise<SettlementResult> {
        const idemRedisKey = `escrow:idempotency:${params.callerOrgId}:${params.idempotencyKey}`;

        // Đặt khóa nguyên tử NX (chỉ thành công nếu khóa chưa từng tồn tại)
        const acquired = await this.redis.set(idemRedisKey, 'PROCESSING', 'EX', 86400, 'NX');
        if (acquired !== 'OK') {
            throw new AppError(
                409,
                'IDEMPOTENT_REPLAY',
                `Khóa lũy đẳng ${params.idempotencyKey} đã được sử dụng hoặc đang xử lý.`
            );
        }

        try {
            const result = await this.repo.settleMilestoneAtomic({
                contractId: params.contractId,
                milestoneId: params.milestoneId,
                callerOrgId: params.callerOrgId,
                referenceCode: `SETTLE-${params.idempotencyKey}`,
            });

            // Xóa cache cũ sau khi trạng thái hợp đồng thay đổi (Cache Invalidation)
            await this.redis.del(`escrow:contract:${params.contractId}:org:${params.callerOrgId}`);

            // Đẩy việc xuất hóa đơn PDF & bắn Webhook đối soát sang hàng đợi ngầm BullMQ
            await this.auditQueue.add('dispatch-settlement-receipt', {
                contractId: result.contractId,
                milestoneId: result.milestoneId,
                amount: result.releasedAmount,
                referenceCode: result.referenceCode,
                settledByOrgId: params.callerOrgId,
            });

            await this.redis.set(idemRedisKey, JSON.stringify(result), 'EX', 86400);
            return result;
        } catch (err) {
            // Nếu lỗi nghiệp vụ (như sai quyền hoặc không tìm thấy), giải phóng khóa lũy đẳng
            await this.redis.del(idemRedisKey);
            throw err;
        }
    }
}