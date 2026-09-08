import { randomUUID } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { getRedis, keys } from "./redis.js";
import { hashToken, envBool, envInt, setAdvancedMode } from "./security.js";

export interface AuthedRequest extends Request {
  sessionId?: string;
}

// POST /api/auth/session [ { advanced?: boolean } ] -> { sessionId, token, ... }
// Guarda sess:{sha256(token)} = sessionId com TTL. O Bearer cru nunca
// é persistido: um dump do Redis não vaza credenciais utilizáveis.
// Rate-limited por IP (authLimiter) contra enumeração/criação em massa.
export async function createSession(req: Request, res: Response) {
  const sessionId = randomUUID();
  const token = randomUUID();
  const ttlHours = envInt("SESSION_TTL_HOURS", 24);
  const redis = getRedis();
  await redis.set(keys.session(hashToken(token)), sessionId, "EX", ttlHours * 3600);
  // Opt-in do execute_luau já na criação (ação humana).
  const advanced = (req.body as { advanced?: unknown } | undefined)?.advanced === true;
  if (advanced) await setAdvancedMode(sessionId, true);
  res.status(201).json({ sessionId, token, advanced, expiresInHours: ttlHours });
}

// Middleware: exige Authorization: Bearer <token> válido e registrado.
// Sem fallback permissivo por padrão (ALLOW_SELF_SESSION=0).
export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) {
    res.status(401).json({ error: "Falta Authorization: Bearer <token>" });
    return;
  }
  const redis = getRedis();
  const mapped = await redis.get(keys.session(hashToken(token)));
  if (mapped) {
    req.sessionId = mapped;
    next();
    return;
  }
  // Compat legada opcional: token == sessionId (inseguro p/ multiusuário).
  if (envBool("ALLOW_SELF_SESSION", false)) {
    req.sessionId = token;
    next();
    return;
  }
  console.warn(`[auth] token inválido de ${req.ip}`);
  res.status(401).json({ error: "Token inválido ou sessão expirada" });
}
