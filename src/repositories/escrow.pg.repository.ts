import type pg from 'pg';
import { AppError } from '../middlewares/security.middleware.js';

export interface ContractDetailsView {
    contractId: string;
    contractCode: string;
    status: string;
    totalAmount: string;
    participantRole: string;
}

export interface SettlementResult {
    milestoneId: string;
    contractId: string;
    releasedAmount: string;
    referenceCode: string;
}

export class EscrowPgRepository {
    constructor(private readonly pool: pg.Pool) { }

    async getContractForParticipant(
        contractId: string,
        organizationId: string
    ): Promise<ContractDetailsView> {
        const res = await this.pool.query<{
            contract_id: string;
            contract_code: string;
            status: string;
            total_amount: string;
            role: string;
        }>(
            `SELECT c.id AS contract_id, c.contract_code, c.status, c.total_amount::text, cp.role
       FROM escrow_contracts c
       INNER JOIN contract_participants cp ON cp.contract_id = c.id
       WHERE c.id = $1 AND cp.organization_id = $2`,
            [contractId, organizationId]
        );

        const row = res.rows[0];
        if (!row) {
            throw new AppError(
                403,
                'FORBIDDEN_IDOR',
                'Chốt chặn IDOR: Doanh nghiệp của bạn không có quyền truy cập hợp đồng này.'
            );
        }

        return {
            contractId: row.contract_id,
            contractCode: row.contract_code,
            status: row.status,
            totalAmount: row.total_amount,
            participantRole: row.role,
        };
    }

    async settleMilestoneAtomic(params: {
        contractId: string;
        milestoneId: string;
        callerOrgId: string;
        referenceCode: string;
    }): Promise<SettlementResult> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');

            const permRes = await client.query<{ role: string }>(
                `SELECT role FROM contract_participants WHERE contract_id = $1 AND organization_id = $2`,
                [params.contractId, params.callerOrgId]
            );
            const participant = permRes.rows[0];
            if (!participant || (participant.role !== 'BUYER' && participant.role !== 'ARBITRATOR')) {
                throw new AppError(
                    403,
                    'FORBIDDEN_RBAC_IDOR',
                    'Chỉ Bên Mua hoặc Trọng Tài thuộc hợp đồng này mới có quyền giải ngân.'
                );
            }

            const contractRes = await client.query<{ status: string }>(
                `SELECT status FROM escrow_contracts WHERE id = $1 FOR UPDATE`,
                [params.contractId]
            );
            if (contractRes.rows[0]?.status === 'DISPUTED') {
                throw new AppError(
                    409,
                    'CONTRACT_IN_DISPUTE',
                    'Hợp đồng đang tranh chấp (DISPUTED), không thể giải ngân trực tiếp qua v1.0!'
                );
            }

            const msRes = await client.query<{ id: string; status: string; amount: string }>(
                `SELECT id, status, amount::text
         FROM contract_milestones
         WHERE id = $1 AND contract_id = $2
         FOR UPDATE`,
                [params.milestoneId, params.contractId]
            );
            const milestone = msRes.rows[0];
            if (!milestone) {
                throw new AppError(404, 'MILESTONE_NOT_FOUND', 'Không tìm thấy đợt thanh toán.');
            }
            if (milestone.status !== 'LOCKED') {
                throw new AppError(
                    409,
                    'MILESTONE_ALREADY_PROCESSED',
                    `Đợt thanh toán đã ở trạng thái ${milestone.status}.`
                );
            }

            const walletsRes = await client.query<{ wallet_id: string; role: string }>(
                `SELECT w.id AS wallet_id, cp.role
         FROM contract_participants cp
         INNER JOIN escrow_wallets w ON w.organization_id = cp.organization_id
         WHERE cp.contract_id = $1 AND cp.role IN ('BUYER', 'SELLER')
         FOR UPDATE OF w`,
                [params.contractId]
            );

            const buyerWallet = walletsRes.rows.find((r) => r.role === 'BUYER');
            const sellerWallet = walletsRes.rows.find((r) => r.role === 'SELLER');
            if (!buyerWallet || !sellerWallet) {
                throw new AppError(422, 'WALLET_CONFIG_MISSING', 'Thiếu cấu hình ví Bên Mua hoặc Bên Bán.');
            }

            await client.query(
                `UPDATE escrow_wallets SET locked_balance = locked_balance - $1, updated_at = NOW() WHERE id = $2`,
                [milestone.amount, buyerWallet.wallet_id]
            );
            await client.query(
                `UPDATE escrow_wallets SET available_balance = available_balance + $1, updated_at = NOW() WHERE id = $2`,
                [milestone.amount, sellerWallet.wallet_id]
            );

            await client.query(
                `INSERT INTO ledger_entries (wallet_id, contract_id, entry_type, amount, reference_code)
         VALUES ($1, $3, 'DEBIT', $4, $5), ($2, $3, 'CREDIT', $4, $5)`,
                [
                    buyerWallet.wallet_id,
                    sellerWallet.wallet_id,
                    params.contractId,
                    milestone.amount,
                    params.referenceCode,
                ]
            );

            await client.query(
                `UPDATE contract_milestones SET status = 'RELEASED', released_at = NOW() WHERE id = $1`,
                [milestone.id]
            );
            await client.query(`UPDATE escrow_contracts SET status = 'RELEASED' WHERE id = $1`, [
                params.contractId,
            ]);

            await client.query('COMMIT');
            return {
                milestoneId: milestone.id,
                contractId: params.contractId,
                releasedAmount: milestone.amount,
                referenceCode: params.referenceCode,
            };
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }

    async settleDisputeSplitAtomic(params: {
        contractId: string;
        milestoneId: string;
        callerOrgId: string;
        buyerRefundPct: number;
        sellerPayoutPct: number;
        referenceCode: string;
    }): Promise<SettlementResult> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');

            const msRes = await client.query<{ id: string; status: string; amount: string }>(
                `SELECT id, status, amount::text
         FROM contract_milestones
         WHERE id = $1 AND contract_id = $2
         FOR UPDATE`,
                [params.milestoneId, params.contractId]
            );
            const milestone = msRes.rows[0];
            if (!milestone || milestone.status !== 'LOCKED') {
                throw new AppError(409, 'MILESTONE_ALREADY_PROCESSED', 'Đợt thanh toán không ở trạng thái LOCKED.');
            }

            const walletsRes = await client.query<{ wallet_id: string; role: string }>(
                `SELECT w.id AS wallet_id, cp.role
         FROM contract_participants cp
         INNER JOIN escrow_wallets w ON w.organization_id = cp.organization_id
         WHERE cp.contract_id = $1 AND cp.role IN ('BUYER', 'SELLER')
         FOR UPDATE OF w`,
                [params.contractId]
            );

            const buyerWallet = walletsRes.rows.find((r) => r.role === 'BUYER');
            const sellerWallet = walletsRes.rows.find((r) => r.role === 'SELLER');
            if (!buyerWallet || !sellerWallet) {
                throw new AppError(422, 'WALLET_CONFIG_MISSING', 'Thiếu cấu hình ví Bên Mua hoặc Bên Bán.');
            }

            const total = Number(milestone.amount);
            const buyerRefund = ((total * params.buyerRefundPct) / 100).toFixed(4);
            const sellerPayout = ((total * params.sellerPayoutPct) / 100).toFixed(4);

            await client.query(
                `UPDATE escrow_wallets
         SET locked_balance = locked_balance - $1,
             available_balance = available_balance + $2,
             updated_at = NOW()
         WHERE id = $3`,
                [milestone.amount, buyerRefund, buyerWallet.wallet_id]
            );
            await client.query(
                `UPDATE escrow_wallets
         SET available_balance = available_balance + $1,
             updated_at = NOW()
         WHERE id = $2`,
                [sellerPayout, sellerWallet.wallet_id]
            );

            await client.query(
                `INSERT INTO ledger_entries (wallet_id, contract_id, entry_type, amount, reference_code)
         VALUES
           ($1, $3, 'DEBIT', $4, $7),
           ($1, $3, 'CREDIT', $5, $7),
           ($2, $3, 'CREDIT', $6, $7)`,
                [
                    buyerWallet.wallet_id,
                    sellerWallet.wallet_id,
                    params.contractId,
                    milestone.amount,
                    buyerRefund,
                    sellerPayout,
                    params.referenceCode,
                ]
            );

            await client.query(
                `UPDATE contract_milestones SET status = 'RELEASED', released_at = NOW() WHERE id = $1`,
                [milestone.id]
            );
            await client.query(`UPDATE escrow_contracts SET status = 'RELEASED' WHERE id = $1`, [
                params.contractId,
            ]);

            await client.query('COMMIT');
            return {
                milestoneId: milestone.id,
                contractId: params.contractId,
                releasedAmount: sellerPayout,
                referenceCode: params.referenceCode,
            };
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }
}