import { randomUUID } from "node:crypto";
import { getRedis, keys } from "./redis.js";
import { assertPayloadAllowed, envInt } from "./security.js";

export interface StudioCommand {
  id: string;
  type: string;
  payload: Record<string, unknown>;
}

const COMMAND_TIMEOUT = Number(process.env.COMMAND_TIMEOUT_SEC ?? 25);
const POLL_TIMEOUT = Number(process.env.BRIDGE_POLL_TIMEOUT_SEC ?? 25);

// BRPOP bloqueia a conexão: usa um duplicado dedicado por espera,
// senão o long-poll do plugin travaria os comandos da IA (mesma conexão).
async function blockingPop(key: string, timeoutSec: number): Promise<string | null> {
  const sub = getRedis().duplicate();
  try {
    const res = await sub.brpop(key, timeoutSec);
    return res ? res[1] : null;
  } finally {
    sub.disconnect();
  }
}

// Auditoria: quem pediu o quê, e se deu certo. Por sessão, últimos N.
async function audit(sessionId: string, type: string, ok: boolean, error?: string): Promise<void> {
  try {
    const redis = getRedis();
    const entry = JSON.stringify({ ts: new Date().toISOString(), type, ok, error });
    const key = `audit:${sessionId}`;
    await redis.lpush(key, entry);
    await redis.ltrim(key, 0, envInt("AUDIT_KEEP", 200) - 1);
    await redis.expire(key, 7 * 24 * 3600);
  } catch {
    // auditoria nunca quebra o comando
  }
}

export async function getAudit(sessionId: string, limit = 50): Promise<unknown[]> {
  const redis = getRedis();
  const items = await redis.lrange(`audit:${sessionId}`, 0, Math.min(limit, 200) - 1);
  const out: unknown[] = [];
  for (const s of items) {
    try {
      out.push(JSON.parse(s));
    } catch {
      // entrada corrompida: ignora em vez de derrubar o /history
    }
  }
  return out;
}

// Presença: cada poll do plugin carimba place/job (TTL curto).
// list_sessions mostra só Studios com poll recente = realmente conectados.
export interface Presence {
  sessionId: string;
  place: string;
  placeId: string;
  jobId: string;
  lastSeen: string;
}

export async function recordPresence(
  sessionId: string,
  info: { place?: string; placeId?: string; jobId?: string }
): Promise<void> {
  try {
    const entry: Presence = {
      sessionId,
      place: info.place ?? "",
      placeId: info.placeId ?? "",
      jobId: info.jobId ?? "",
      lastSeen: new Date().toISOString(),
    };
    await getRedis().set(`presence:${sessionId}`, JSON.stringify(entry), "EX", 120);
  } catch {
    // presença nunca quebra o comando
  }
}

export async function listPresence(): Promise<Presence[]> {
  const redis = getRedis();
  const out: Presence[] = [];
  let cursor = "0";
  do {
    const [next, found] = await redis.scan(cursor, "MATCH", "presence:*", "COUNT", 100);
    cursor = next;
    if (found.length > 0) {
      const vals = await redis.mget(found);
      for (const v of vals) {
        if (!v) continue;
        try {
          out.push(JSON.parse(v) as Presence);
        } catch {
          // ignora entrada corrompida
        }
      }
    }
  } while (cursor !== "0");
  return out;
}

// IA -> Redis: valida, enfileira e espera o plugin responder em result:{id}
export async function enqueueAndWait(
  sessionId: string,
  type: string,
  payload: Record<string, unknown> = {}
): Promise<unknown> {
  await assertPayloadAllowed(type, payload, sessionId); // guards: Luau e tamanho (MCP e REST)
  const redis = getRedis();
  const id = randomUUID();
  const cmd: StudioCommand = { id, type, payload };
  await redis.lpush(keys.queue(sessionId), JSON.stringify(cmd));
  // BRPOP bloqueante: espera o plugin dar LPUSH em result:{id}
  try {
    const raw = await blockingPop(keys.result(id), COMMAND_TIMEOUT);
    if (!raw) throw new Error(`Timeout: plugin da sessão ${sessionId} não respondeu em ${COMMAND_TIMEOUT}s`);
    await audit(sessionId, type, true);
    return JSON.parse(raw);
  } catch (e) {
    await audit(sessionId, type, false, e instanceof Error ? e.message : String(e));
    throw e;
  }
}

// Plugin -> Redis: long-poll por próximo comando da sua sessão
export async function dequeueForPlugin(sessionId: string): Promise<StudioCommand | null> {
  const raw = await blockingPop(keys.queue(sessionId), POLL_TIMEOUT);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StudioCommand;
  } catch {
    console.warn(`[queue] comando corrompido descartado na sessão ${sessionId}`);
    return null;
  }
}

// Plugin -> Redis: devolve o resultado para a IA que está esperando
export async function completeCommand(commandId: string, result: unknown): Promise<void> {
  const redis = getRedis();
  await redis.lpush(keys.result(commandId), JSON.stringify(result));
  await redis.expire(keys.result(commandId), 120);
}
