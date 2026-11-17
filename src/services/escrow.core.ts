import { CreateEscrowInput, EscrowContract, EscrowContractState, FeeTier } from '../types/escrow.types.js';

// ============================================================================
// [Mục 2.1] CLOSURE & LEXICAL ENVIRONMENT: Bộ sinh mã bút toán an toàn, không lộ biến đếm
// ============================================================================
export function createTxRefGenerator(prefix: string): () => string {
    let sequence = 1000;
    return () => {
        sequence += 1;
        return `${prefix}-${Date.now()}-${sequence}`;
    };
}

// ============================================================================
// [Mục 3.3] DSA — ĐỒ THỊ TRẠNG THÁI (STATE GRAPH): Chốt chặn luồng chuyển trạng thái
// ============================================================================
const ALLOWED_TRANSITIONS: Record<EscrowContractState['status'], ReadonlySet<EscrowContractState['status']>> = {
    FUNDED: new Set(['DISPUTED', 'RELEASED']),
    DISPUTED: new Set(['RELEASED']),
    RELEASED: new Set([]), // Trạng thái kết thúc (Terminal Node), không thể chuyển tiếp
};

export function assertValidTransition(
    current: EscrowContractState['status'],
    next: EscrowContractState['status']
): void {
    const allowedNextStates = ALLOWED_TRANSITIONS[current];
    // [Mục 2.3] Kiểm tra tường minh theo yêu cầu của noUncheckedIndexedAccess
    if (!allowedNextStates || !allowedNextStates.has(next)) {
        throw new Error(`Chuyển trạng thái bất hợp lệ trên State Graph: ${current} -> ${next}`);
    }
}

// ============================================================================
// [Mục 3.1 & 3.2] OCP, LSP + STRATEGY & FACTORY PATTERN: Tính phí ký quỹ B2B
// ============================================================================
export interface IFeeStrategy {
    calculateFeeCents(amountCents: number): number;
}

export class StandardB2BFeeStrategy implements IFeeStrategy {
    calculateFeeCents(amountCents: number): number {
        return Math.round(amountCents * 0.015); // 1.5%
    }
}

export class CrossBorderFeeStrategy implements IFeeStrategy {
    calculateFeeCents(amountCents: number): number {
        return Math.round(amountCents * 0.025) + 5000; // 2.5% + phụ phí cố định
    }
}

export class EnterpriseVipFeeStrategy implements IFeeStrategy {
    calculateFeeCents(amountCents: number): number {
        return Math.round(amountCents * 0.005); // 0.5%
    }
}

export class FeeStrategyFactory {
    private static readonly strategies: Record<FeeTier, IFeeStrategy> = {
        STANDARD_B2B: new StandardB2BFeeStrategy(),
        CROSS_BORDER: new CrossBorderFeeStrategy(),
        ENTERPRISE_VIP: new EnterpriseVipFeeStrategy(),
    };

    static getStrategy(tier: FeeTier): IFeeStrategy {
        const strategy = this.strategies[tier];
        if (!strategy) {
            throw new Error(`Không tìm thấy chiến lược tính phí cho gói: ${tier}`);
        }
        return strategy;
    }
}

// ============================================================================
// [Mục 3.1 & 3.2] ISP, DIP + REPOSITORY PATTERN: Tách giao diện Đọc và Ghi
// ============================================================================
export interface IEscrowReadRepository {
    findByCode(contractCode: string): EscrowContract | undefined;
    findAll(): EscrowContract[];
}

export interface IEscrowWriteRepository {
    save(contract: EscrowContract): void;
}

export class InMemoryEscrowRepository implements IEscrowReadRepository, IEscrowWriteRepository {
    private readonly store = new Map<string, EscrowContract>();

    findByCode(contractCode: string): EscrowContract | undefined {
        return this.store.get(contractCode);
    }

    findAll(): EscrowContract[] {
        return Array.from(this.store.values());
    }

    save(contract: EscrowContract): void {
        this.store.set(contract.contractCode, contract);
    }
}

// ============================================================================
// [Mục 3.2] COMMAND PATTERN: Đóng gói lệnh giải ngân thành đối tượng độc lập
// ============================================================================
export class ReleaseEscrowCommand {
    constructor(
        public readonly contractCode: string,
        public readonly idempotencyKey: string
    ) { }
}

// ============================================================================
// [Mục 3.1 & Nguyên tắc 4] CORE SERVICE LAYER: Một tầng Services dùng chung cho cả 3 phiên bản
// ============================================================================
export class EscrowService {
    private readonly nextContractId = createTxRefGenerator('ESC');
    private readonly nextPayoutRef = createTxRefGenerator('PAYOUT');
    private readonly processedIdempotencyKeys = new Set<string>();

    constructor(
        private readonly readRepo: IEscrowReadRepository,
        private readonly writeRepo: IEscrowWriteRepository
    ) { }

    createContract(input: CreateEscrowInput): EscrowContract {
        const existing = this.readRepo.findByCode(input.contractCode);
        if (existing) {
            throw new Error(`DUPLICATE_CONTRACT: Hợp đồng ${input.contractCode} đã tồn tại.`);
        }

        const contract: EscrowContract = {
            id: this.nextContractId(),
            contractCode: input.contractCode,
            buyerOrgId: input.buyerOrgId,
            sellerOrgId: input.sellerOrgId,
            feeTier: input.feeTier,
            state: {
                status: 'FUNDED',
                fundedAt: new Date().toISOString(),
                lockedAmountCents: input.amountCents,
            },
        };

        this.writeRepo.save(contract);
        return contract;
    }

    executeRelease(cmd: ReleaseEscrowCommand): EscrowContract {
        if (this.processedIdempotencyKeys.has(cmd.idempotencyKey)) {
            throw new Error(`IDEMPOTENT_REPLAY: Khóa lũy đẳng ${cmd.idempotencyKey} đã được thực thi.`);
        }

        const contract = this.readRepo.findByCode(cmd.contractCode);
        if (!contract) {
            throw new Error(`NOT_FOUND: Không tìm thấy hợp đồng ${cmd.contractCode}.`);
        }

        // Kiểm tra trên State Graph
        assertValidTransition(contract.state.status, 'RELEASED');

        if (contract.state.status !== 'FUNDED') {
            throw new Error('INVALID_STATE: Chỉ hợp đồng ở trạng thái FUNDED mới được giải ngân trực tiếp.');
        }

        const strategy = FeeStrategyFactory.getStrategy(contract.feeTier);
        const feeCents = strategy.calculateFeeCents(contract.state.lockedAmountCents);
        const netPaidCents = contract.state.lockedAmountCents - feeCents;

        const updated: EscrowContract = {
            ...contract,
            state: {
                status: 'RELEASED',
                payoutTxRef: this.nextPayoutRef(),
                netPaidCents,
                releasedAt: new Date().toISOString(),
            },
        };

        this.processedIdempotencyKeys.add(cmd.idempotencyKey);
        this.writeRepo.save(updated);
        return updated;
    }

    listContracts(): EscrowContract[] {
        return this.readRepo.findAll();
    }

    // [Mục 3.3] DSA — Tối ưu đối soát sao kê từ O(n^2) về O(n) bằng Hash Table (Map)
    reconcileWithBankStatement(bankRecords: Array<{ contractCode: string; bankAmountCents: number }>) {
        const internalContracts = this.readRepo.findAll();
        const internalLookup = new Map<string, number>();

        for (const item of internalContracts) {
            if (item.state.status === 'FUNDED') {
                internalLookup.set(item.contractCode, item.state.lockedAmountCents);
            } else if (item.state.status === 'RELEASED') {
                internalLookup.set(item.contractCode, item.state.netPaidCents);
            }
        }

        const matched: string[] = [];
        const mismatched: Array<{ contractCode: string; expected: number | undefined; actual: number }> = [];

        for (const row of bankRecords) {
            const expected = internalLookup.get(row.contractCode);
            if (expected === row.bankAmountCents) {
                matched.push(row.contractCode);
            } else {
                mismatched.push({ contractCode: row.contractCode, expected, actual: row.bankAmountCents });
            }
        }

        return { complexity: 'O(n) via Hash Map', matchedCount: matched.length, matched, mismatched };
    }
}