import http from 'node:http';
import { parseCreateEscrowInput } from './types/escrow.types.js';
import {
    EscrowService,
    InMemoryEscrowRepository,
    ReleaseEscrowCommand,
} from './services/escrow.core.js';

const repository = new InMemoryEscrowRepository();
const escrowService = new EscrowService(repository, repository);

const ADMIN_HTML = `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8" />
  <title>FinEscrow Backoffice Console (GĐ 1-3)</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 820px; margin: 2rem auto; padding: 0 1rem; background: #f8fafc; color: #0f172a; }
    .card { background: #fff; padding: 1.25rem; border-radius: 12px; border: 1px solid #e2e8f0; margin-bottom: 1.25rem; }
    .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 0.75rem; }
    input, select, button { padding: 0.6rem; border-radius: 6px; border: 1px solid #cbd5e1; font-size: 0.95rem; }
    button { background: #2563eb; color: #fff; border: none; cursor: pointer; grid-column: span 2; }
    ul { list-style: none; padding: 0; }
    li { padding: 0.6rem; border-bottom: 1px solid #f1f5f9; font-family: monospace; }
  </style>
</head>
<body>
  <h2>FinEscrow — Màn Hình Quản Trị Ký Quỹ Tối Giản (Chống XSS)</h2>
  <div class="card">
    <form id="escrowForm" class="grid">
      <input name="contractCode" placeholder="Mã HĐ (thử nhập <img src=x onerror=alert(1)>)" required />
      <input name="amountCents" type="number" placeholder="Số tiền (Cents, VD: 500000)" required />
      <input name="buyerOrgId" placeholder="Mã DN Mua (VD: ORG-BUYER-01)" required />
      <input name="sellerOrgId" placeholder="Mã DN Bán (VD: ORG-SELLER-02)" required />
      <select name="feeTier" style="grid-column: span 2;">
        <option value="STANDARD_B2B">STANDARD_B2B (Phí 1.5%)</option>
        <option value="CROSS_BORDER">CROSS_BORDER (Phí 2.5% + 5000)</option>
        <option value="ENTERPRISE_VIP">ENTERPRISE_VIP (Phí 0.5%)</option>
      </select>
      <button type="submit">Khởi Tạo Hợp Đồng Ký Quỹ</button>
    </form>
  </div>
  <div class="card">
    <h3>Danh Sách Hợp Đồng Hiện Có (Render an toàn qua textContent)</h3>
    <ul id="contractList"></ul>
  </div>
  <script>
    async function loadContracts() {
      const res = await fetch('/api/v1/escrows');
      const data = await res.json();
      const list = document.getElementById('contractList');
      list.innerHTML = '';
      for (const item of data.contracts) {
        const li = document.createElement('li');
        // [Mục 1.1] Bắt buộc dùng textContent thay vì innerHTML để chống XSS tuyệt đối
        li.textContent = \`[\${item.state.status}] \${item.contractCode} | Mua: \${item.buyerOrgId} -> Bán: \${item.sellerOrgId} | Gói: \${item.feeTier}\`;
        list.appendChild(li);
      }
    }
    document.getElementById('escrowForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      await fetch('/api/v1/escrows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contractCode: fd.get('contractCode'),
          buyerOrgId: fd.get('buyerOrgId'),
          sellerOrgId: fd.get('sellerOrgId'),
          amountCents: Number(fd.get('amountCents')),
          feeTier: fd.get('feeTier'),
        }),
      });
      e.target.reset();
      await loadContracts();
    });
    loadContracts();
  </script>
</body>
</html>`;

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf-8');
    return raw ? JSON.parse(raw) : {};
}

const server = http.createServer(async (req, res) => {
    try {
        if (req.method === 'GET' && req.url === '/') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(ADMIN_HTML);
            return;
        }

        if (req.method === 'GET' && req.url === '/api/v1/escrows') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ contracts: escrowService.listContracts() }));
            return;
        }

        if (req.method === 'POST' && req.url === '/api/v1/escrows') {
            const body = await readJsonBody(req);
            const validated = parseCreateEscrowInput(body);
            const created = escrowService.createContract(validated);
            console.log(`[ESCROW_CREATED] code=${created.contractCode} amount=${validated.amountCents}`);
            res.writeHead(201, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(created));
            return;
        }

        if (req.method === 'POST' && req.url === '/api/v1/escrows/release') {
            const idempotencyKey = req.headers['idempotency-key'];
            if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Thiếu header Idempotency-Key bắt buộc.' }));
                return;
            }
            const body = (await readJsonBody(req)) as Record<string, unknown>;
            const contractCode = typeof body.contractCode === 'string' ? body.contractCode : '';
            const released = escrowService.executeRelease(new ReleaseEscrowCommand(contractCode, idempotencyKey));
            console.log(`[ESCROW_RELEASED] code=${released.contractCode} key=${idempotencyKey}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(released));
            return;
        }

        if (req.method === 'POST' && req.url === '/api/v1/escrows/reconcile') {
            const body = (await readJsonBody(req)) as { statements?: Array<{ contractCode: string; bankAmountCents: number }> };
            const report = escrowService.reconcileWithBankStatement(body.statements ?? []);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(report));
            return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Endpoint không tồn tại.' }));
    } catch (err) {
        const message = err instanceof Error ? err.message : 'Lỗi máy chủ nội bộ';
        const status = message.startsWith('DUPLICATE_') || message.startsWith('IDEMPOTENT_') ? 409 : 422;
        console.error(`[ESCROW_ERROR] status=${status} msg=${message}`);
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: message }));
    }
});

server.listen(3000, () => {
    console.log('FinEscrow Server (GĐ 1-3) đang chạy tại http://localhost:3000');
});