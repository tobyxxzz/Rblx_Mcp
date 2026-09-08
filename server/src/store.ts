// Seletor de backend (híbrido local-first).
//
//   STORE=memory | redis   → vence sempre (quando definido)
//   sem STORE             → redis se REDIS_URL estiver explícito no ambiente,
//                           senão memory (bridge local, zero dependências)
//
// No Render (REDIS_URL configurado) continua Redis sem mudar nada no
// dashboard. No PC do usuário (sem REDIS_URL) usa memória automaticamente.
// `rblx-mcp bridge --redis <url>` força Redis localmente quando preciso.
import { getRedis as getRedisBackend, keys } from "./redis.js";
import { getMemory } from "./memory.js";

export { keys };

export type StoreClient =
  | ReturnType<typeof getRedisBackend>
  | ReturnType<typeof getMemory>;

let choice: "memory" | "redis" | null = null;

export function backendName(): "memory" | "redis" {
  if (choice) return choice;
  const explicit = (process.env.STORE ?? "").toLowerCase().trim();
  if (explicit === "redis" || explicit === "memory") {
    choice = explicit;
  } else {
    choice = process.env.REDIS_URL ? "redis" : "memory";
  }
  return choice;
}

export function getRedis(): StoreClient {
  return backendName() === "redis" ? getRedisBackend() : getMemory();
}
