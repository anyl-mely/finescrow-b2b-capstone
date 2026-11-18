import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { z, type ZodSchema } from 'zod';

// ============================================================================
// [Mục 5.1] GLOBAL ERROR HANDLING: Lớp lỗi chuẩn hóa toàn hệ thống
// ============================================================================
export class AppError extends Error {
    constructor(
        public readonly statusCode: number,
        public readonly errorCode: string,
        message: string
    ) {
        super(message);
    }
}

export function globalErrorHandler(
    err: unknown,
    _req: Request,
    res: Response,
    _next: NextFunction
): void {
    if (err instanceof AppError) {
        res.status(err.statusCode).json({
            error: err.errorCode,
            message: err.message,
        });
        return;
    }

    const message = err instanceof Error ? err.message : 'Lỗi hệ thống không xác định';
    res.status(500).json({
        error: 'INTERNAL_SERVER_ERROR',
        message,
    });
}

// ============================================================================
// [Mục 5.1] ZOD VALIDATION MIDDLEWARE: Chặn lọc dữ liệu sai ngay tại cửa ngõ
// ============================================================================
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ReleaseMilestoneSchema = z.object({
    contractId: z.string().regex(UUID_REGEX, 'contractId phải là UUID hợp lệ'),
    milestoneId: z.string().regex(UUID_REGEX, 'milestoneId phải là UUID hợp lệ'),
});

export function validateBody<T>(schema: ZodSchema<T>) {
    return (req: Request, _res: Response, next: NextFunction): void => {
        const parsed = schema.safeParse(req.body);
        if (!parsed.success) {
            const firstIssue = parsed.error.issues[0];
            next(
                new AppError(
                    422,
                    'VALIDATION_ERROR',
                    firstIssue ? firstIssue.message : 'Dữ liệu đầu vào không hợp lệ'
                )
            );
            return;
        }
        req.body = parsed.data;
        next();
    };
}

// ============================================================================
// [Mục 5.3] PASSWORD HASHING & JWT ROTATION (HttpOnly Cookie)
// ============================================================================
const JWT_SECRET = process.env.JWT_SECRET ?? 'finescrow-super-secret-key-2026';
const activeRefreshTokens = new Set<string>();

export interface AuthContext {
    userId: string;
    organizationId: string;
    role: 'BUYER' | 'SELLER' | 'ARBITRATOR';
    jti: string;
}

export function hashPassword(password: string): string {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    return `${salt}:${hash}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
    const parts = storedHash.split(':');
    const salt = parts[0];
    const originalHash = parts[1];
    if (!salt || !originalHash) return false;
    const hashBuffer = crypto.scryptSync(password, salt, 64);
    const originalBuffer = Buffer.from(originalHash, 'hex');
    return crypto.timingSafeEqual(hashBuffer, originalBuffer);
}

export function signJwtToken(payload: Omit<AuthContext, 'jti'>, registerRefresh = false): {
    token: string;
    jti: string;
} {
    const jti = crypto.randomUUID();
    const fullPayload: AuthContext = { ...payload, jti };
    const data = Buffer.from(JSON.stringify(fullPayload)).toString('base64url');
    const signature = crypto.createHmac('sha256', JWT_SECRET).update(data).digest('base64url');
    if (registerRefresh) {
        activeRefreshTokens.add(jti);
    }
    return { token: `${data}.${signature}`, jti };
}

export function verifyJwtToken(token: string): AuthContext {
    const parts = token.split('.');
    const data = parts[0];
    const signature = parts[1];
    if (!data || !signature) {
        throw new AppError(401, 'INVALID_TOKEN', 'Định dạng Token không hợp lệ.');
    }
    const expectedSig = crypto.createHmac('sha256', JWT_SECRET).update(data).digest('base64url');
    if (signature !== expectedSig) {
        throw new AppError(401, 'INVALID_SIGNATURE', 'Chữ ký Token đã bị giả mạo.');
    }
    return JSON.parse(Buffer.from(data, 'base64url').toString('utf-8')) as AuthContext;
}

// Xoay vòng Refresh Token (JWT Rotation): Thu hồi token cũ ngay khi cấp token mới
export function rotateRefreshToken(oldToken: string, res: Response): string {
    const decoded = verifyJwtToken(oldToken);
    if (!activeRefreshTokens.has(decoded.jti)) {
        // Phát hiện dùng lại Refresh Token đã thu hồi -> Xóa toàn bộ phiên để bảo vệ tài khoản
        activeRefreshTokens.clear();
        throw new AppError(401, 'TOKEN_REUSE_DETECTED', 'Phát hiệnRefresh Token bị dùng lại bất hợp pháp!');
    }
    activeRefreshTokens.delete(decoded.jti);

    const nextRefresh = signJwtToken(
        { userId: decoded.userId, organizationId: decoded.organizationId, role: decoded.role },
        true
    );

    res.setHeader(
        'Set-Cookie',
        `refresh_token=${nextRefresh.token}; HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth/refresh`
    );

    return signJwtToken({
        userId: decoded.userId,
        organizationId: decoded.organizationId,
        role: decoded.role,
    }).token;
}

declare global {
    namespace Express {
        interface Request {
            auth?: AuthContext;
        }
    }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        next(new AppError(401, 'UNAUTHORIZED', 'Thiếu Bearer Access Token.'));
        return;
    }
    const token = authHeader.slice(7);
    try {
        req.auth = verifyJwtToken(token);
        next();
    } catch (err) {
        next(err);
    }
}

// ============================================================================
// [Mục 5.3] RATE LIMITING CHI TIẾT THEO NHÓM ENDPOINT NHẠY CẢM
// ============================================================================
export function createRateLimiter(maxRequests: number, windowMs: number) {
    const hits = new Map<string, { count: number; resetAt: number }>();

    return (req: Request, _res: Response, next: NextFunction): void => {
        const key = `${req.ip ?? 'local'}:${req.path}`;
        const now = Date.now();
        const record = hits.get(key);

        if (!record || now > record.resetAt) {
            hits.set(key, { count: 1, resetAt: now + windowMs });
            next();
            return;
        }

        if (record.count >= maxRequests) {
            next(new AppError(429, 'RATE_LIMIT_EXCEEDED', 'Vượt quá giới hạn gọi API cho phép.'));
            return;
        }

        record.count += 1;
        next();
    };
}