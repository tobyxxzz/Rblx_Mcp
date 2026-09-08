// Backend em memória (modo local): mesma interface usada do Redis,
// sem dependência externa. Um processo = um usuário, então não há
// problema de múltiplas instâncias como no modo remoto (Render).
//
// Suporta o subconjunto usado pelo projeto:
// KV com TTL (set EX / get / del / expire), listas (lpush / brpop
// bloqueante / ltrim / lrange), scan MATCH + mget (presença).

interface Waiter {
  resolve: (v: [string, string] | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class MemoryStore {
  private kv = new Map<string, { value: string; exp: number }>();
  private lists = new Map<string, string[]>();
  private waiters = new Map<string, Waiter[]>();

  constructor() {
    // Varredura de TTL expirado (não segura o processo aberto).
    const t = setInterval(() => this.sweep(), 30_000);
    if (typeof t === "object" && "unref" in t && typeof t.unref === "function") t.unref();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [k, e] of this.kv) {
      if (e.exp <= now) this.kv.delete(k);
    }
  }

  private getEntry(key: string): string | null {
    const e = this.kv.get(key);
    if (!e) return null;
    if (e.exp <= Date.now()) {
      this.kv.delete(key);
      return null;
    }
    return e.value;
  }

  async set(key: string, value: string, ...args: (string | number)[]): Promise<string> {
    let ttlMs = 0;
    for (let i = 0; i < args.length; i++) {
      if (String(args[i]).toUpperCase() === "EX" && typeof args[i + 1] === "number") {
        ttlMs = (args[i + 1] as number) * 1000;
        break;
      }
    }
    this.kv.set(key, { value, exp: ttlMs > 0 ? Date.now() + ttlMs : Number.POSITIVE_INFINITY });
    return "OK";
  }

  async get(key: string): Promise<string | null> {
    return this.getEntry(key);
  }

  async del(key: string): Promise<number> {
    return this.kv.delete(key) ? 1 : 0;
  }

  async expire(key: string, seconds: number): Promise<number> {
    const v = this.getEntry(key);
    if (v === null) return 0;
    this.kv.set(key, { value: v, exp: Date.now() + seconds * 1000 });
    return 1;
  }

  async lpush(key: string, value: string): Promise<number> {
    let lst = this.lists.get(key);
    if (!lst) {
      lst = [];
      this.lists.set(key, lst);
    }
    lst.unshift(value);
    // Acorda um long-poll (BRPOP) esperando nesta chave.
    const queue = this.waiters.get(key);
    const w = queue?.shift();
    if (w) {
      clearTimeout(w.timer);
      const item = lst.pop();
      w.resolve(item === undefined ? null : [key, item]);
    }
    return lst.length;
  }

  async brpop(key: string, timeoutSec: number): Promise<[string, string] | null> {
    const lst = this.lists.get(key);
    const item = lst?.pop();
    if (item !== undefined) return [key, item];
    // Bloqueia até LPUSH ou timeout (igual ao BRPOP do Redis).
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const queue = this.waiters.get(key);
        if (queue) {
          const i = queue.findIndex((x) => x.resolve === resolve);
          if (i >= 0) queue.splice(i, 1);
        }
        resolve(null);
      }, Math.max(0, timeoutSec) * 1000);
      let queue = this.waiters.get(key);
      if (!queue) {
        queue = [];
        this.waiters.set(key, queue);
      }
      queue.push({ resolve, timer });
    });
  }

  async ltrim(key: string, start: number, stop: number): Promise<string> {
    const lst = this.lists.get(key) ?? [];
    this.lists.set(key, lst.slice(start, stop + 1));
    return "OK";
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const lst = this.lists.get(key) ?? [];
    return lst.slice(start, stop + 1);
  }

  async scan(_cursor: string, ...args: (string | number)[]): Promise<[string, string[]]> {
    // Suporta: scan(cursor, "MATCH", pattern, "COUNT", n). Retorna tudo de
    // uma vez (cursor "0" = fim); presença tem poucas chaves, sem problema.
    let pattern = "*";
    for (let i = 0; i < args.length; i++) {
      if (String(args[i]).toUpperCase() === "MATCH" && typeof args[i + 1] === "string") {
        pattern = args[i + 1] as string;
      }
    }
    const re = new RegExp("^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
    const found: string[] = [];
    for (const k of this.kv.keys()) {
      if (re.test(k) && this.getEntry(k) !== null) found.push(k);
    }
    for (const k of this.lists.keys()) {
      if (re.test(k)) found.push(k);
    }
    return ["0", found];
  }

  async mget(keys: string[]): Promise<(string | null)[]> {
    return keys.map((k) => this.getEntry(k));
  }

  duplicate(): { brpop: (key: string, timeoutSec: number) => Promise<[string, string] | null>; disconnect: () => void } {
    // Mesma conexão (memória é thread-única): só replica a API usada.
    return {
      brpop: (key, timeoutSec) => this.brpop(key, timeoutSec),
      disconnect: () => {},
    };
  }
}

let instance: MemoryStore | null = null;

export function getMemory(): MemoryStore {
  if (!instance) instance = new MemoryStore();
  return instance;
}
