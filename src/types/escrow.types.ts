export type FeeTier = 'STANDARD_B2B' | 'CROSS_BORDER' | 'ENTERPRISE_VIP';

// [Mục 2.3] Discriminated Unions: Trạng thái nào chỉ mang đúng dữ liệu của trạng thái đó
export type EscrowContractState =
    | { status: 'FUNDED'; fundedAt: string; lockedAmountCents: number }
    | { status: 'DISPUTED'; disputeReason: string; frozenAmountCents: number; openedAt: string }
    | { status: 'RELEASED'; payoutTxRef: string; netPaidCents: number; releasedAt: string };

export interface EscrowContract {
    readonly id: string;
    readonly contractCode: string;
    readonly buyerOrgId: string;
    readonly sellerOrgId: string;
    readonly feeTier: FeeTier;
    readonly state: EscrowContractState;
}

export interface CreateEscrowInput {
    contractCode: string;
    buyerOrgId: string;
    sellerOrgId: string;
    amountCents: number;
    feeTier: FeeTier;
}

// [Mục 2.3] Làm chủ 'unknown' & Type Narrowing (tuyệt đối không dùng 'any')
export function parseCreateEscrowInput(rawPayload: unknown): CreateEscrowInput {
    if (typeof rawPayload !== 'object' || rawPayload === null) {
        throw new Error('Payload phải là một đối tượng JSON hợp lệ.');
    }

    const record = rawPayload as Record<string, unknown>;
    const { contractCode, buyerOrgId, sellerOrgId, amountCents, feeTier } = record;

    if (typeof contractCode !== 'string' || contractCode.trim().length < 3) {
        throw new Error('Mã hợp đồng (contractCode) phải có ít nhất 3 ký tự.');
    }
    if (typeof buyerOrgId !== 'string' || typeof sellerOrgId !== 'string' || buyerOrgId === sellerOrgId) {
        throw new Error('Mã doanh nghiệp Mua và Bán phải hợp lệ và khác nhau.');
    }
    if (typeof amountCents !== 'number' || !Number.isInteger(amountCents) || amountCents <= 0) {
        throw new Error('Số tiền ký quỹ (amountCents) phải là số nguyên dương.');
    }
    if (feeTier !== 'STANDARD_B2B' && feeTier !== 'CROSS_BORDER' && feeTier !== 'ENTERPRISE_VIP') {
        throw new Error('Gói biểu phí (feeTier) không hợp lệ.');
    }

    return {
        contractCode: contractCode.trim(),
        buyerOrgId: buyerOrgId.trim(),
        sellerOrgId: sellerOrgId.trim(),
        amountCents,
        feeTier,
    };
}