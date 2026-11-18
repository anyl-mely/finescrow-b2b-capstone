DROP TABLE IF EXISTS agent_checkpoints CASCADE;
DROP TABLE IF EXISTS agent_audit_logs CASCADE;
DROP TABLE IF EXISTS contract_knowledge_chunks CASCADE;

-- 1. [Mục 6.2 & 6.3] Bảng Lưu Trữ Ngữ Cảnh Hợp Đồng (Vector + Full-Text Search)
CREATE TABLE contract_knowledge_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id UUID NOT NULL REFERENCES escrow_contracts(id) ON DELETE CASCADE,
  chunk_index INT NOT NULL,
  chunk_text TEXT NOT NULL,
  embedding_model_version VARCHAR(32) NOT NULL DEFAULT 'finescrow-embed-v1',
  embedding vector(8) NOT NULL,
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', chunk_text)) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Chỉ mục đồ thị HNSW cho tìm kiếm Vector Cosine
CREATE INDEX idx_chunks_embedding_hnsw ON contract_knowledge_chunks
USING hnsw (embedding vector_cosine_ops);

-- Chỉ mục GIN cho tìm kiếm từ khóa chính xác (Full-Text Search)
CREATE INDEX idx_chunks_tsv_gin ON contract_knowledge_chunks
USING GIN (tsv);

-- 2. [Mục 7.1] Bảng Nhật Ký Hành Động Của Agent (Append-Only Bất Biến)
CREATE TABLE agent_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id VARCHAR(64) NOT NULL,
  caller_org_id UUID NOT NULL,
  caller_role VARCHAR(20) NOT NULL,
  tool_name VARCHAR(64) NOT NULL,
  risk_tier INT NOT NULL CHECK (risk_tier IN (0, 1, 2)),
  input_payload JSONB NOT NULL,
  decision_status VARCHAR(32) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Trigger khóa cứng không cho phép UPDATE hoặc DELETE dòng lịch sử Audit Log
CREATE OR REPLACE FUNCTION prevent_audit_log_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'IMMUTABLE_AUDIT_LOG: Bảng agent_audit_logs chỉ cho phép thêm mới (Append-Only), cấm sửa hoặc xóa!';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_immutable_audit_log
BEFORE UPDATE OR DELETE ON agent_audit_logs
FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_mutation();

-- 3. [Mục 7.3 & 7.5] Bảng Lưu Vết Trạng Thái Đồ Thị Agent (Checkpointing & Time-Travel)
CREATE TABLE agent_checkpoints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id VARCHAR(64) NOT NULL,
  step_index INT NOT NULL,
  node_name VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL CHECK (status IN ('RUNNING', 'PAUSED_FOR_HITL', 'COMPLETED', 'ABORTED_BUDGET')),
  working_memory JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (thread_id, step_index)
);