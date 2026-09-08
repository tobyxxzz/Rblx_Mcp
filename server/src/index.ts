import "dotenv/config";
import express from "express";
import { createSession, requireAuth, type AuthedRequest } from "./auth.js";
import { enqueueAndWait, dequeueForPlugin, completeCommand, getAudit, recordPresence, listPresence } from "./queue.js";
import { setupMcpRoutes } from "./mcp.js";
import { backendName } from "./store.js";
import { setupSecurity, apiLimiter, authLimiter, mcpMsgLimiter, setAdvancedMode, isAdvancedMode, envBool } from "./security.js";

const app = express();
setupSecurity(app); // helmet + CORS restrito + trust proxy opcional
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

// ---- Autenticação: cria sessão (token por sessão, hash no Redis) ----
app.post("/api/auth/session", authLimiter, createSession);

// ---- Bridge REST (plugin + debug) ----
const cmds = express.Router();
cmds.use(requireAuth, apiLimiter); // tudo aqui exige sessão válida + rate limit por sessão

// Presença: o plugin manda ?place=&placeId=&jobId= a cada poll.
// Serve ao list_sessions (IA descobre Studios conectados sem adivinhar).
cmds.use((req: AuthedRequest, _res, next) => {
  const q = req.query as Record<string, unknown>;
  if (typeof q["place"] === "string" && q["place"]) {
    void recordPresence(req.sessionId!, {
      place: q["place"],
      placeId: typeof q["placeId"] === "string" ? q["placeId"] : "",
      jobId: typeof q["jobId"] === "string" ? q["jobId"] : "",
    });
  }
  next();
});

// Plugin (Usuário A/B): long-poll pelo próximo comando da SUA sessão.
cmds.get("/next", async (req: AuthedRequest, res) => {
  const cmd = await dequeueForPlugin(req.sessionId!);
  res.json({ command: cmd }); // null = timeout, plugin faz poll de novo
});

// Plugin -> servidor: entrega resultado para a IA que está esperando.
cmds.post("/result", async (req: AuthedRequest, res) => {
  const { id, ok, data, error } = req.body ?? {};
  if (!id) {
    res.status(400).json({ error: "Falta {id}" });
    return;
  }
  await completeCommand(String(id), { ok: ok !== false, data, error });
  res.json({ ok: true });
});

// Debug/REST: enfileira comando e espera plugin responder (guards aplicados).
cmds.post("/send", async (req: AuthedRequest, res) => {
  const { type, payload, sessionId } = req.body ?? {};
  if (!type) {
    res.status(400).json({ error: "Falta {type}" });
    return;
  }
  try {
    const target = typeof sessionId === "string" && sessionId ? sessionId : req.sessionId!;
    if (target !== req.sessionId && !envBool("ALLOW_CROSS_SESSION", false)) {
      res.status(403).json({ ok: false, error: "sessionId de outra sessão não permitido" });
      return;
    }
    const result = await enqueueAndWait(target, String(type), payload ?? {});
    res.json({ ok: true, result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const blocked = /bloquead|desabilitado|excede|precisa ser|opt-in/i.test(msg);
    res.status(blocked ? 403 : 504).json({ ok: false, error: msg });
  }
});

// Modo avançado da própria sessão (opt-in do execute_luau). Ação humana.
cmds.post("/mode", async (req: AuthedRequest, res) => {
  const on = (req.body as { advanced?: unknown } | undefined)?.advanced === true;
  await setAdvancedMode(req.sessionId!, on);
  res.json({ sessionId: req.sessionId, advanced: await isAdvancedMode(req.sessionId!) });
});

// Studios conectados no momento (poll recente). A IA usa p/ escolher alvo.
cmds.get("/sessions", async (_req: AuthedRequest, res) => {
  res.json({ sessions: await listPresence() });
});

// Auditoria da própria sessão (últimos comandos, ok/erro).
cmds.get("/history", async (req: AuthedRequest, res) => {
  const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
  res.json({ items: await getAudit(req.sessionId!, limit) });
});

app.use("/api/commands", cmds);

// ---- Transporte MCP: SSE remoto ----
setupMcpRoutes(app, mcpMsgLimiter);

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`[rblx-mcp] bridge online em http://localhost:${port} (backend: ${backendName()})`);
  console.log(`[rblx-mcp] MCP SSE em http://localhost:${port}/mcp/sse`);
});
