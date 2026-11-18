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

    async getContractDetails(
        contractId: string,
        callerOrgId: string
    ): Promise<{ source: 'REDIS_CACHE' | 'POSTGRES_DB'; data: ContractDetailsView }> {
        const cacheKey = `escrow:contract:${contractId}:org:${callerOrgId}`;
        const cached = await this.redis.get(cacheKey);
        if (cached) {
            return { source: 'REDIS_CACHE', data: JSON.parse(cached) as ContractDetailsView };
        }
        const details = await this.repo.getContractForParticipant(contractId, callerOrgId);
        await this.redis.set(cacheKey, JSON.stringify(details), 'EX', 60);
        return { source: 'POSTGRES_DB', data: details };
    }

    async releaseMilestone(params: {
        contractId: string;
        milestoneId: string;
        callerOrgId: string;
        idempotencyKey: string;
    }): Promise<SettlementResult> {
        const idemRedisKey = `escrow:idempotency:${params.callerOrgId}:${params.idempotencyKey}`;
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

            await this.redis.del(`escrow:contract:${params.contractId}:org:${params.callerOrgId}`);
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
            await this.redis.del(idemRedisKey);
            throw err;
        }
    }

    async settleDisputeSplit(params: {
        contractId: string;
        milestoneId: string;
        callerOrgId: string;
        buyerRefundPct: number;
        sellerPayoutPct: number;
        idempotencyKey: string;
    }): Promise<SettlementResult> {
        const idemRedisKey = `escrow:idempotency:${params.callerOrgId}:${params.idempotencyKey}`;
        const acquired = await this.redis.set(idemRedisKey, 'PROCESSING', 'EX', 86400, 'NX');
        if (acquired !== 'OK') {
            throw new AppError(
                409,
                'IDEMPOTENT_REPLAY',
                `Khóa lũy đẳng ${params.idempotencyKey} đã được sử dụng hoặc đang xử lý.`
            );
        }

        try {
            const result = await this.repo.settleDisputeSplitAtomic({
                contractId: params.contractId,
                milestoneId: params.milestoneId,
                callerOrgId: params.callerOrgId,
                buyerRefundPct: params.buyerRefundPct,
                sellerPayoutPct: params.sellerPayoutPct,
                referenceCode: `SETTLE-${params.idempotencyKey}`,
            });

            await this.redis.del(`escrow:contract:${params.contractId}:org:${params.callerOrgId}`);
            await this.auditQueue.add('dispatch-dispute-split-receipt', {
                contractId: result.contractId,
                milestoneId: result.milestoneId,
                sellerPayout: result.releasedAmount,
                referenceCode: result.referenceCode,
                settledByOrgId: params.callerOrgId,
            });

            await this.redis.set(idemRedisKey, JSON.stringify(result), 'EX', 86400);
            return result;
        } catch (err) {
            await this.redis.del(idemRedisKey);
            throw err;
        }
    }
}