#!/usr/bin/env node
// rblx-mcp MCPB proxy: stdio (NDJSON) <-> SSE remoto do bridge.
// Env: RBLX_BRIDGE_URL=https://seu-bridge.onrender.com  RBLX_MCP_TOKEN=...
// Zero dependências (Node 18+: fetch global + TextDecoder).
// Protocolo: GET /mcp/sse recebe `endpoint` + `message`; POST /mcp/messages?... envia.
"use strict";

const BRIDGE = (process.env.RBLX_BRIDGE_URL || "").replace(/\/+$/, "");
const TOKEN = process.env.RBLX_MCP_TOKEN || "";
if (!BRIDGE || !TOKEN) {
  console.error("[rblx-mcp] faltam RBLX_BRIDGE_URL e/ou RBLX_MCP_TOKEN");
  process.exit(1);
}

let postUrl = null;
let pending = [];
let sseClosed = false;

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function sendError(id, message) {
  send({ jsonrpc: "2.0", id: id === undefined ? null : id, error: { code: -32000, message } });
}

async function postMessage(msg) {
  if (!postUrl) {
    if (!sseClosed) pending.push(msg);
    else sendError(msg && msg.id, "Conexão SSE fechada pelo servidor");
    return;
  }
  try {
    const res = await fetch(postUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(msg),
    });
    // 202 vazio = ok; a resposta real chega via SSE. Corpo só interessa em erro.
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      sendError(msg && msg.id, `Bridge HTTP ${res.status}: ${String(txt).slice(0, 200)}`);
    } else {
      await res.arrayBuffer().catch(() => {});
    }
  } catch (e) {
    sendError(msg && msg.id, `Falha ao falar com bridge: ${e.message}`);
  }
}

async function runSse() {
  const res = await fetch(`${BRIDGE}/mcp/sse`, {
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: "text/event-stream" },
  });
  if (!res.ok || !res.body) {
    console.error(`[rblx-mcp] SSE HTTP ${res.status} — confira URL e token`);
    process.exit(1);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let evName = "";
  let evData = [];

  const dispatch = () => {
    if (evName === "endpoint") {
      const ep = evData.join("\n").trim();
      if (ep) {
        postUrl = new URL(ep, BRIDGE).toString();
        const q = pending;
        pending = [];
        for (const m of q) void postMessage(m);
      }
    } else if (evName === "message") {
      const raw = evData.join("\n").trim();
      if (raw) process.stdout.write(raw + "\n");
    }
    evName = "";
    evData = [];
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        let line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line === "") dispatch();
        else if (line[0] === ":") { /* keepalive SSE, ignora */ }
        else if (line.startsWith("event:")) evName = line.slice(6).trim();
        else if (line.startsWith("data:")) evData.push(line.slice(5).replace(/^ /, ""));
      }
    }
  } catch (e) {
    console.error(`[rblx-mcp] SSE erro: ${e.message}`);
  }
  sseClosed = true;
  console.error("[rblx-mcp] SSE fechado pelo servidor (reinicie o host p/ reconectar)");
  process.exit(1);
}

// stdin: uma mensagem JSON-RPC por linha (notifications sem id também encaminham).
let inBuf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  inBuf += chunk;
  let idx;
  while ((idx = inBuf.indexOf("\n")) >= 0) {
    const line = inBuf.slice(0, idx).trim();
    inBuf = inBuf.slice(idx + 1);
    if (!line) continue;
    try {
      void postMessage(JSON.parse(line));
    } catch {
      // linha inválida: ignora
    }
  }
});
process.stdin.on("end", () => process.exit(0));
process.stdin.resume();

runSse().catch((e) => {
  console.error(`[rblx-mcp] fatal: ${e.message}`);
  process.exit(1);
});
