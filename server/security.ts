import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import type { Request, Response } from "express";

export const helmetMiddleware = helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
});

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

export const corsMiddleware = cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.length === 0) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "x-api-key", "Idempotency-Key", "Authorization"],
});

const apiKeyOrIp = (req: Request): string => {
  const apiKey = req.headers["x-api-key"];
  if (typeof apiKey === "string" && apiKey) return `key:${apiKey}`;
  return `ip:${req.ip ?? "unknown"}`;
};

const rlMessage = (limit: number) => ({
  error: "Rate limit exceeded",
  code: "RATE_LIMIT_EXCEEDED",
  detail: `Maximum ${limit} requests per minute per API key`,
});

export const readRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: apiKeyOrIp,
  message: rlMessage(200),
  statusCode: 429,
});

export const writeRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: apiKeyOrIp,
  message: rlMessage(60),
  statusCode: 429,
});

export const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request): string => `ip:${req.ip ?? "unknown"}`,
  message: { error: "Too many login attempts. Try again in 15 minutes.", code: "ADMIN_LOGIN_THROTTLED" },
  statusCode: 429,
});

export type ApiErrorCode =
  | "VALIDATION_FAILED"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "EMAIL_TAKEN"
  | "IDENTITY_NOT_FOUND"
  | "LEAD_NOT_FOUND"
  | "RATE_LIMIT_EXCEEDED"
  | "INTERNAL_ERROR";

export function apiError(
  res: Response,
  status: number,
  code: ApiErrorCode,
  message: string,
  details?: unknown,
) {
  const body: { error: string; code: ApiErrorCode; details?: unknown } = { error: message, code };
  if (details !== undefined) body.details = details;
  return res.status(status).json(body);
}

const PII_FIELDS = new Set([
  "currentPhone",
  "previousPhones",
  "phone",
  "email",
  "fullName",
  "dateOfBirth",
  "anniversary",
  "profilePhoto",
  "emergencyContactName",
  "emergencyContactPhone",
  "medicalHistory",
  "injuries",
  "healthConditions",
  "password",
  "rawKey",
  "keyHash",
]);

export function redactPII(body: unknown, depth = 0): unknown {
  if (depth > 4 || body === null || body === undefined) return body;
  if (Array.isArray(body)) return body.map(item => redactPII(item, depth + 1));
  if (typeof body !== "object") return body;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (PII_FIELDS.has(k) && v !== null && v !== undefined) {
      out[k] = "[REDACTED]";
    } else if (typeof v === "object") {
      out[k] = redactPII(v, depth + 1);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function assertProductionConfig() {
  if (process.env.NODE_ENV !== "production") return;
  const errors: string[] = [];
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === "befiter-admin-secret-change-in-production") {
    errors.push("SESSION_SECRET must be set to a strong unique value in production");
  }
  if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD === "admin123") {
    errors.push("ADMIN_PASSWORD must be set (and not 'admin123') in production");
  }
  if (errors.length > 0) {
    console.error("[startup] FATAL: insecure production config:");
    for (const e of errors) console.error("  - " + e);
    process.exit(1);
  }
}
