import { Redis } from "ioredis";

let client: Redis | null = null;

export function getRedis(): Redis {
  if (!client) {
    const url = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
    client = new Redis(url, { maxRetriesPerRequest: null });
    client.on("error", (e: Error) => console.error("[redis] erro:", e.message));
  }
  return client;
}

export const keys = {
  queue: (sessionId: string) => `queue:${sessionId}`,
  result: (commandId: string) => `result:${commandId}`,
  session: (token: string) => `sess:${token}`,
};
