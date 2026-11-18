import type pg from 'pg';
import { AppError, type AuthContext } from '../middlewares/security.middleware.js';
import type { EscrowV1Service } from './escrow.v1.service.js';
import type { RagV2Service } from './rag.v2.service.js';

// ============================================================================
// [Mục 7.4] COST & LATENCY BUDGETING: 3 ngưỡng chặn cứng bắt buộc
// ============================================================================
export interface AgentBudgetConfig {
    maxIterations: number;
    executionTimeoutMs: number;
    tokenCeiling: number;
}

export interface AgentWorkingMemory {
    contractId: string;
    milestoneId: string;
    disputeClaim: string;
    retrievedClauses: string[];
    proposedBuyerRefundPct: number;
    proposedSellerPayoutPct: number;
    selfCorrectionCount: number;
    tokensUsed: number;
    iterationsUsed: number;
    settlementReference?: string;
}

export class AutonomousDisputeAgent {
    constructor(
        private readonly pool: pg.Pool,
        private readonly ragService: RagV2Service,
        private readonly escrowV1Service: EscrowV1Service
    ) { }

    private async writeImmutableAuditLog(params: {
        threadId: string;
        jwtContext: AuthContext;
        toolName: string;
        riskTier: 0 | 1 | 2;
        inputPayload: Record<string, unknown>;
        decisionStatus: string;
    }): Promise<void> {
        await this.pool.query(
            `INSERT INTO agent_audit_logs
         (thread_id, caller_org_id, caller_role, tool_name, risk_tier, input_payload, decision_status)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
            [
                params.threadId,
                params.jwtContext.organizationId,
                params.jwtContext.role,
                params.toolName,
                params.riskTier,
                JSON.stringify(params.inputPayload),
                params.decisionStatus,
            ]
        );
    }

    private async saveCheckpoint(params: {
        threadId: string;
        stepIndex: number;
        nodeName: string;
        status: 'RUNNING' | 'PAUSED_FOR_HITL' | 'COMPLETED' | 'ABORTED_BUDGET';
        memory: AgentWorkingMemory;
    }): Promise<void> {
        await this.pool.query(
            `INSERT INTO agent_checkpoints (thread_id, step_index, node_name, status, working_memory)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (thread_id, step_index)
       DO UPDATE SET status = EXCLUDED.status, working_memory = EXCLUDED.working_memory`,
            [params.threadId, params.stepIndex, params.nodeName, params.status, JSON.stringify(params.memory)]
        );
    }

    private assertWithinBudget(
        memory: AgentWorkingMemory,
        budget: AgentBudgetConfig,
        startedAtMs: number
    ): void {
        if (memory.iterationsUsed >= budget.maxIterations) {
            throw new AppError(429, 'AGENT_MAX_ITERATIONS_EXCEEDED', 'Agent đã chạm trần số vòng lặp maxIterations.');
        }
        if (Date.now() - startedAtMs > budget.executionTimeoutMs) {
            throw new AppError(408, 'AGENT_EXECUTION_TIMEOUT', 'Agent đã vượt ngưỡng thời gian executionTimeoutMs.');
        }
        if (memory.tokensUsed > budget.tokenCeiling) {
            throw new AppError(429, 'AGENT_TOKEN_CEILING_EXCEEDED', 'Agent đã vượt trần ngân sách tokenCeiling.');
        }
    }

    // [Mục 7.1, 7.2, 7.3 & 7.4] Chạy đồ thị trạng thái State Machine đến điểm dừng HITL
    async runDisputeWorkflow(params: {
        threadId: string;
        jwtContext: AuthContext;
        contractId: string;
        milestoneId: string;
        disputeClaim: string;
        initialDraftSplit?: { buyerPct: number; sellerPct: number };
        budget?: AgentBudgetConfig;
    }): Promise<{ status: string; stepIndex: number; memory: AgentWorkingMemory }> {
        const budget: AgentBudgetConfig = params.budget ?? {
            maxIterations: 6,
            executionTimeoutMs: 25_000,
            tokenCeiling: 12_000,
        };
        const startedAt = Date.now();

        const memory: AgentWorkingMemory = {
            contractId: params.contractId,
            milestoneId: params.milestoneId,
            disputeClaim: params.disputeClaim,
            retrievedClauses: [],
            proposedBuyerRefundPct: params.initialDraftSplit?.buyerPct ?? 30,
            proposedSellerPayoutPct: params.initialDraftSplit?.sellerPct ?? 80, // Giả lập tổng 110% để kích hoạt Self-Correction
            selfCorrectionCount: 0,
            tokensUsed: 1500,
            iterationsUsed: 1,
        };

        // NODE 1: RetrieveEvidenceNode (Gọi Tool Mức 0 — Chỉ đọc, có tiêm jwtContext.organizationId)
        this.assertWithinBudget(memory, budget, startedAt);
        const ragMatches = await this.ragService.hybridSearchRbac({
            contractId: params.contractId,
            callerOrgId: params.jwtContext.organizationId, // [Mục 7.1] Security Context Injection từ JWT
            queryText: params.disputeClaim,
            topK: 2,
        });
        memory.retrievedClauses = ragMatches.map((m) => m.chunkText);
        memory.tokensUsed += 1800;
        memory.iterationsUsed += 1;

        await this.writeImmutableAuditLog({
            threadId: params.threadId,
            jwtContext: params.jwtContext,
            toolName: 'search_contract_clauses',
            riskTier: 0,
            inputPayload: { contractId: params.contractId, query: params.disputeClaim },
            decisionStatus: 'EXECUTED_TIER_0',
        });
        await this.saveCheckpoint({
            threadId: params.threadId,
            stepIndex: 1,
            nodeName: 'RetrieveEvidenceNode',
            status: 'RUNNING',
            memory,
        });

        // NODE 2: FreezeContractNode (Gọi Tool Mức 1 — Tự động tạm khóa hợp đồng đang khiếu nại)
        this.assertWithinBudget(memory, budget, startedAt);
        await this.pool.query(`UPDATE escrow_contracts SET status = 'DISPUTED' WHERE id = $1`, [
            params.contractId,
        ]);
        memory.tokensUsed += 1200;
        memory.iterationsUsed += 1;

        await this.writeImmutableAuditLog({
            threadId: params.threadId,
            jwtContext: params.jwtContext,
            toolName: 'freeze_disputed_contract',
            riskTier: 1,
            inputPayload: { contractId: params.contractId },
            decisionStatus: 'AUTO_EXECUTED_TIER_1',
        });
        await this.saveCheckpoint({
            threadId: params.threadId,
            stepIndex: 2,
            nodeName: 'FreezeContractNode',
            status: 'RUNNING',
            memory,
        });

        // NODE 3: CriticAndSelfCorrectionNode ([Mục 7.2] Vòng lặp tự phục hồi lỗi khi tổng tỷ lệ != 100%)
        this.assertWithinBudget(memory, budget, startedAt);
        if (memory.proposedBuyerRefundPct + memory.proposedSellerPayoutPct !== 100) {
            memory.selfCorrectionCount += 1;
            memory.proposedBuyerRefundPct = 20;
            memory.proposedSellerPayoutPct = 80;
        }
        memory.tokensUsed += 1500;
        memory.iterationsUsed += 1;

        // NODE 4: RiskGateNode ([Mục 7.1 & 7.5] Chạm Tool Mức 2 -> Đóng băng đồ thị chờ HITL phê duyệt)
        await this.writeImmutableAuditLog({
            threadId: params.threadId,
            jwtContext: params.jwtContext,
            toolName: 'execute_arbitration_payout',
            riskTier: 2,
            inputPayload: {
                contractId: params.contractId,
                milestoneId: params.milestoneId,
                buyerPct: memory.proposedBuyerRefundPct,
                sellerPct: memory.proposedSellerPayoutPct,
            },
            decisionStatus: 'PAUSED_WAITING_HITL',
        });

        await this.saveCheckpoint({
            threadId: params.threadId,
            stepIndex: 3,
            nodeName: 'RiskGateNode_Tier2_HITL',
            status: 'PAUSED_FOR_HITL',
            memory,
        });

        return {
            status: 'PAUSED_FOR_HITL',
            stepIndex: 3,
            memory,
        };
    }

    // [Mục 7.5] Đánh thức (Resume) Agent từ Checkpoint sau khi Trọng tài viên bấm phê duyệt HITL
    async approveAndResumeHitl(params: {
        threadId: string;
        arbitratorJwt: AuthContext;
        idempotencyKey: string;
    }): Promise<{ status: string; stepIndex: number; memory: AgentWorkingMemory }> {
        if (params.arbitratorJwt.role !== 'ARBITRATOR' && params.arbitratorJwt.role !== 'BUYER') {
            throw new AppError(403, 'FORBIDDEN_HITL_APPROVER', 'Chỉ Trọng tài viên hoặc Bên Mua mới được duyệt giải ngân.');
        }

        const cpRes = await this.pool.query<{
            step_index: number;
            status: string;
            working_memory: AgentWorkingMemory;
        }>(
            `SELECT step_index, status, working_memory
       FROM agent_checkpoints
       WHERE thread_id = $1
       ORDER BY step_index DESC
       LIMIT 1`,
            [params.threadId]
        );

        const latestCheckpoint = cpRes.rows[0];
        if (!latestCheckpoint || latestCheckpoint.status !== 'PAUSED_FOR_HITL') {
            throw new AppError(409, 'INVALID_CHECKPOINT_STATE', 'Phiên Agent không ở trạng thái chờ phê duyệt HITL.');
        }

        const memory = latestCheckpoint.working_memory;

        // Tái sử dụng trực tiếp tầng EscrowV1Service từ Giai đoạn 5 ("Một tầng Services — Ba cổng giao tiếp")
        const settlement = await this.escrowV1Service.releaseMilestone({
            contractId: memory.contractId,
            milestoneId: memory.milestoneId,
            callerOrgId: params.arbitratorJwt.organizationId,
            idempotencyKey: params.idempotencyKey,
        });

        memory.settlementReference = settlement.referenceCode;

        await this.writeImmutableAuditLog({
            threadId: params.threadId,
            jwtContext: params.arbitratorJwt,
            toolName: 'execute_arbitration_payout',
            riskTier: 2,
            inputPayload: { milestoneId: memory.milestoneId, referenceCode: settlement.referenceCode },
            decisionStatus: 'HITL_APPROVED_AND_SETTLED',
        });

        const nextStep = latestCheckpoint.step_index + 1;
        await this.saveCheckpoint({
            threadId: params.threadId,
            stepIndex: nextStep,
            nodeName: 'SettlementCompletedNode',
            status: 'COMPLETED',
            memory,
        });

        return {
            status: 'COMPLETED',
            stepIndex: nextStep,
            memory,
        };
    }

    // [Mục 7.3] TIME-TRAVEL DEBUGGING: Tua ngược về bất kỳ bước nào của Agent trong quá khứ
    async timeTravelInspect(threadId: string, stepIndex: number): Promise<{
        nodeName: string;
        status: string;
        memory: AgentWorkingMemory;
    }> {
        const res = await this.pool.query<{
            node_name: string;
            status: string;
            working_memory: AgentWorkingMemory;
        }>(
            `SELECT node_name, status, working_memory
       FROM agent_checkpoints
       WHERE thread_id = $1 AND step_index = $2`,
            [threadId, stepIndex]
        );

        const row = res.rows[0];
        if (!row) {
            throw new AppError(404, 'CHECKPOINT_NOT_FOUND', `Không tìm thấy mốc Time-Travel tại bước ${stepIndex}.`);
        }

        return {
            nodeName: row.node_name,
            status: row.status,
            memory: row.working_memory,
        };
    }
}

// ============================================================================
// [Mục 7.5] CỔNG GIAO TIẾP THỨ BA: FINESCROW MCP SERVER (Model Context Protocol)
// ============================================================================
export class FinEscrowMcpServer {
    constructor(private readonly ragService: RagV2Service) { }

    listTools() {
        return [
            {
                name: 'finescrow_search_clauses',
                description: 'Tra cứu điều khoản hợp đồng ký quỹ B2B có phân quyền RBAC-Aware Hybrid Search',
                riskTier: 0,
            },
            {
                name: 'finescrow_settle_dispute_hitl',
                description: 'Giải ngân hoặc chia tiền ký quỹ sau tranh chấp (Tool Mức 2 — Yêu cầu phê duyệt HITL)',
                riskTier: 2,
            },
        ];
    }

    async callTool(params: {
        toolName: string;
        jwtContext: AuthContext;
        arguments: { contractId: string; queryText: string };
    }) {
        if (params.toolName === 'finescrow_search_clauses') {
            const results = await this.ragService.hybridSearchRbac({
                contractId: params.arguments.contractId,
                callerOrgId: params.jwtContext.organizationId,
                queryText: params.arguments.queryText,
            });
            return { content: [{ type: 'text', text: JSON.stringify(results) }] };
        }
        throw new AppError(400, 'UNKNOWN_MCP_TOOL', `Tool MCP không tồn tại: ${params.toolName}`);
    }
}