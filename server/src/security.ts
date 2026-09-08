import crypto from "node:crypto";
import cors from "cors";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import type { Express } from "express";
import type { AuthedRequest } from "./auth.js";
import { getRedis } from "./store.js";

export function envStr(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

export function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function envBool(name: string, fallback: boolean): boolean {
  const v = (process.env[name] ?? "").toLowerCase().trim();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return fallback;
}

// Nunca guarda o Bearer cru no Redis: a chave é sha256(token).
// Um dump do Redis não vaza credenciais utilizáveis.
export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

// ---- Limites ----
// Por sessão (após requireAuth): plugin faz ~3 req/min ocioso; IA, poucas.
// Por IP: só p/ criar sessão e mensagens MCP (sem identidade de sessão).
export function sessionKey(req: unknown): string {
  return (req as AuthedRequest).sessionId ?? "unknown";
}

export const apiLimiter = rateLimit({
  windowMs: envInt("RATE_LIMIT_WINDOW_MS", 60_000),
  max: envInt("RATE_LIMIT_MAX", 120),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: sessionKey,
  message: { error: "Rate limit por sessão excedido, tente de novo em instantes" },
});

export const authLimiter = rateLimit({
  windowMs: envInt("AUTH_LIMIT_WINDOW_MS", 60_000),
  max: envInt("AUTH_LIMIT_MAX", 10),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Muitas sessões criadas, aguarde um minuto" },
});

export const mcpMsgLimiter = rateLimit({
  windowMs: 60_000,
  max: envInt("MCP_MSG_LIMIT_MAX", 300),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Rate limit excedido" },
});

// ---- Guards de conteúdo (valem p/ MCP e REST: aplicados em enqueueAndWait) ----
export const MAX_SOURCE_BYTES = () => envInt("MAX_SOURCE_BYTES", 200_000);
export const MAX_LUAU_BYTES = () => envInt("MAX_LUAU_BYTES", 20_000);

// Padrões perigosos p/ execute_luau. Lista curta de propósito:
// bloqueia o catastrófico (shutdown, I/O de arquivo, require remoto)
// sem dar falso-positivo em código normal de jogo.
const LUAU_BLOCKLIST: RegExp[] = [
  /game\s*:\s*Shutdown/i,
  /\bos\s*\.\s*(execute|exit|remove|rename|getenv)\b/i,
  /\bio\s*\.\s*(open|popen|write|output|lines)\b/i,
  /\b(writefile|readfile|appendfile|dofile|loadfile)\b/i,
  /\b(getgenv|getrenv|getrawmetatable|sethiddenproperty|setscriptable)\b/i,
  /\brequire\s*\(\s*\d/, // require(id numérico) = puxa código remoto
];

export function extraLuauPatterns(): RegExp[] {
  // LUAU_BLOCKLIST_EXTRA="foo,bar" (separado por vírgula, vira substring case-insensitive)
  const raw = envStr("LUAU_BLOCKLIST_EXTRA", "");
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
}

// Modo avançado (opt-in do execute_luau) é por sessão, ativado por humano via REST.
// A IA nunca vê endpoint p/ isso: ela só descobre a tool se já estiver ativa.
export async function isAdvancedMode(sessionId: string): Promise<boolean> {
  if (!envBool("ALLOW_EXECUTE_LUAU", true)) return false; // kill switch global
  if (envBool("ADVANCED_DEFAULT", false)) return true; // compat: tudo avançado
  if (!sessionId) return false;
  try {
    return (await getRedis().get(`adv:${sessionId}`)) === "1";
  } catch {
    return false; // Redis fora = fail closed
  }
}

export async function setAdvancedMode(sessionId: string, on: boolean): Promise<void> {
  const redis = getRedis();
  if (on) {
    await redis.set(`adv:${sessionId}`, "1", "EX", envInt("SESSION_TTL_HOURS", 24) * 3600);
  } else {
    await redis.del(`adv:${sessionId}`);
  }
}

export async function assertLuauAllowed(code: unknown, sessionId?: string): Promise<void> {
  if (!envBool("ALLOW_EXECUTE_LUAU", true)) {
    throw new Error("execute_luau desabilitado no servidor (ALLOW_EXECUTE_LUAU=0)");
  }
  if (typeof code !== "string" || code.trim() === "") {
    throw new Error("code precisa ser string não-vazia");
  }
  if (Buffer.byteLength(code, "utf8") > MAX_LUAU_BYTES()) {
    throw new Error(`code excede ${MAX_LUAU_BYTES()} bytes`);
  }
  // Opt-in: só entra se a sessão ativou o modo avançado (humano, via REST).
  if (!(await isAdvancedMode(sessionId ?? ""))) {
    throw new Error(
      'execute_luau é opt-in: ative o modo avançado desta sessão com POST /api/commands/mode {"advanced":true}'
    );
  }
  const hit = [...LUAU_BLOCKLIST, ...extraLuauPatterns()].find((re) => re.test(code));
  if (hit) throw new Error(`code bloqueado pela política do servidor (padrão: ${hit.source})`);
}

export function assertSourceSize(source: unknown, field = "source"): asserts source is string {
  if (typeof source !== "string") throw new Error(`${field} precisa ser string`);
  if (Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES()) {
    throw new Error(`${field} excede ${MAX_SOURCE_BYTES()} bytes`);
  }
}

// Validação central de payloads antes de enfileirar (MCP e REST passam aqui).
export async function assertPayloadAllowed(
  type: string,
  payload: Record<string, unknown>,
  sessionId: string
): Promise<void> {
  if (type === "execute_luau") await assertLuauAllowed(payload["code"], sessionId);
  if (type === "create_script") {
    // source e opcional no create (default "" no MCP): so valida se presente.
    if (payload["source"] !== undefined) assertSourceSize(payload["source"]);
    return;
  }
  if (type === "set_script_source") {
    assertSourceSize(payload["source"]);
    return;
  }
  if (type === "set_property") {
    const prop = payload["property"];
    if (typeof prop !== "string" || prop.trim() === "") {
      throw new Error("set_property: property precisa ser string não-vazia");
    }
    // Source so via set_script_source (com limite de bytes): sem isso o
    // set_property vira bypass total dos guards de codigo.
    if (prop.trim().toLowerCase() === "source") {
      throw new Error("set_property não pode alterar Source — use set_script_source");
    }
    return;
  }
  if (type === "set_properties") {
    const props = payload["properties"];
    if (typeof props !== "object" || props === null || Array.isArray(props)) {
      throw new Error("set_properties: properties precisa ser objeto");
    }
    for (const k of Object.keys(props)) {
      if (k.toLowerCase() === "source") {
        throw new Error("set_properties não pode alterar Source — use set_script_source");
      }
    }
    return;
  }
}

// ---- Setup global ----
export function setupSecurity(app: Express): void {
  if (envBool("TRUST_PROXY", false)) app.set("trust proxy", 1);
  app.use(helmet());
  // Sem CORS_ORIGIN: sem headers CORS (clientes MCP são server-side, não precisam).
  // Com CORS_ORIGIN="https://seu-painel.com,https://x.com": libera só essas origens.
  const origins = envStr("CORS_ORIGIN", "");
  if (!origins) {
    app.use(cors({ origin: false }));
  } else {
    const allow = origins.split(",").map((s) => s.trim()).filter(Boolean);
    app.use(cors({ origin: allow }));
  }
}
