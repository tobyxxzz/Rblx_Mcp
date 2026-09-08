#!/usr/bin/env node
// rblx-mcp — instala e configura o Rblx MCP em segundos. Zero dependências.
// Uso:
//   npm i -g https://github.com/tobyxxzz/Rblx_Mcp/releases/download/v0.2.1/rblx-mcp-0.2.1.tgz
//   rblx-mcp init        → guia bridge + sessão + configura Claude/OpenCode/Desktop
//   rblx-mcp session     → cria sessão nova (retorna token)
//   rblx-mcp doctor      → testa bridge, auth e Studios conectados
//   rblx-mcp plugin      → baixa o plugin do Studio p/ a pasta certa
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const readline = require("node:readline/promises");
const { execSync, spawnSync } = require("node:child_process");

// Troque pelo seu repo após subir no GitHub (ou use --repo / RBLX_MCP_REPO).
const DEFAULT_REPO = process.env.RBLX_MCP_REPO || "tobyxxzz/Rblx_Mcp";
const CONFIG_PATH = path.join(os.homedir(), ".rblx-mcp", "config.json");

// ---------- utils ----------
function flags(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = args[i + 1];
    if (!next || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

async function ask(q, def) {
  if (!process.stdin.isTTY) return def || ""; // scripts/CI: nunca trava esperando input
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const suffix = def ? ` [${def}]` : "";
  try {
    const ans = (await rl.question(`${q}${suffix}: `)).trim();
    return ans || def || "";
  } finally {
    rl.close();
  }
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

function normBridge(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

async function api(bridge, p, { method = "GET", token, body } = {}) {
  const res = await fetch(`${bridge}${p}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    // resposta sem JSON
  }
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status} em ${p}`);
  return data;
}

function mergeJsonFile(file, mutate) {
  let cur = {};
  try {
    cur = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    // não existe ou inválido: começa do zero
  }
  mutate(cur);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cur, null, 2));
  return file;
}

function hasBin(bin) {
  try {
    execSync(process.platform === "win32" ? `where ${bin}` : `command -v ${bin}`, {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

// ---------- comandos ----------
async function cmdSession(f) {
  const saved = loadConfig();
  const bridge = normBridge(f.bridge || saved.bridge || (await ask("URL do bridge", "http://127.0.0.1:3000")));
  const advanced = f.advanced === true || f.advanced === "true";
  const data = await api(bridge, "/api/auth/session", {
    method: "POST",
    body: advanced ? { advanced: true } : {},
  });
  saveConfig({ ...saved, bridge });
  console.log("\nSessão criada:");
  console.log(`  sessionId: ${data.sessionId}`);
  console.log(`  token:     ${data.token}   ← cole no plugin do Studio`);
  console.log(`  advanced:  ${data.advanced === true}`);
  console.log(`\nBridge salvo em ${CONFIG_PATH}`);
  return { bridge, token: data.token };
}

async function cmdInit(f) {
  console.log("== rblx-mcp init ==\n");
  const saved = loadConfig();
  const bridge = normBridge(f.bridge || saved.bridge || (await ask("URL do bridge", "http://127.0.0.1:3000")));

  let token = f.token || "";
  if (!token) {
    const criar = await ask("Criar sessão nova agora? (S/n)", "S");
    if (!/^n/i.test(criar)) {
      const adv = await ask("Ativar modo avançado (execute_luau)? (s/N)", "N");
      const data = await api(bridge, "/api/auth/session", {
        method: "POST",
        body: /^s/i.test(adv) ? { advanced: true } : {},
      });
      token = data.token;
      console.log(`\nSessão: ${data.sessionId}\nToken:   ${token}`);
    } else {
      token = await ask("Cole o token da sessão");
    }
  }
  if (!token) throw new Error("Sem token, nada a configurar.");
  saveConfig({ ...saved, bridge, token });

  const sse = `${bridge}/mcp/sse`;
  const done = [];

  // 1) OpenCode (projeto atual). Token via env (opencode.json costuma ir p/ git)
  // e oauth:false (usamos Bearer próprio, sem fluxo OAuth).
  mergeJsonFile(path.join(process.cwd(), "opencode.json"), (j) => {
    j.mcp = j.mcp || {};
    j.mcp["roblox-bridge"] = {
      type: "remote",
      url: sse,
      enabled: true,
      oauth: false,
      headers: { Authorization: "Bearer {env:RBLX_MCP_TOKEN}" },
    };
  });
  done.push("opencode.json (neste diretório)");

  // 2) Claude Code: tenta o comando oficial, senão .mcp.json local
  if (hasBin("claude") && !f["no-claude"]) {
    try {
      const scope = f.scope ? ` --scope ${f.scope}` : "";
      execSync(`claude mcp add${scope} --transport sse roblox-bridge "${sse}" --header "Authorization: Bearer ${token}"`, {
        stdio: "inherit",
      });
      done.push(`claude mcp (scope ${f.scope || "padrão"})`);
    } catch {
      console.log("! 'claude mcp add' falhou — caindo p/ .mcp.json");
    }
  }
  if (done.some((d) => d.startsWith("claude mcp"))) {
    console.log("! O token foi gravado no config do Claude Code — prefira --scope local e nunca commite .mcp.json.");
  }
  if (!done.some((d) => d.startsWith("claude mcp"))) {
    mergeJsonFile(path.join(process.cwd(), ".mcp.json"), (j) => {
      j.mcpServers = j.mcpServers || {};
      j.mcpServers["roblox-bridge"] = { type: "sse", url: sse, headers: { Authorization: `Bearer ${token}` } };
    });
    done.push(".mcp.json (neste diretório, fallback do Claude Code)");
    console.log("! .mcp.json contém o token secreto — NÃO commite (adicione ao .gitignore).");
  }

  // 3) Claude Desktop (best effort). Desktop NÃO fala SSE remoto:
  // usa o proxy stdio mcp-remote (precisa de Node/npx na máquina).
  try {
    const plat = process.platform;
    const desktopPath =
      plat === "win32"
        ? path.join(process.env.APPDATA || "", "Claude", "claude_desktop_config.json")
        : plat === "darwin"
          ? path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json")
          : path.join(os.homedir(), ".config", "Claude", "claude_desktop_config.json");
    if (desktopPath) {
      mergeJsonFile(desktopPath, (j) => {
        j.mcpServers = j.mcpServers || {};
        j.mcpServers["roblox-bridge"] = {
          command: "npx",
          args: ["-y", "mcp-remote", sse, "--header", `Authorization: Bearer ${token}`],
        };
      });
      done.push("Claude Desktop (via mcp-remote)");
    }
  } catch {
    console.log("! Não consegui escrever o config do Claude Desktop (pulei).");
  }

  console.log("\nConfigurado em:");
  for (const d of done) console.log(`  ✓ ${d}`);
  console.log("\nO opencode.json referencia o token via variável de ambiente. Exporte:");
  if (process.platform === "win32") console.log(`  setx RBLX_MCP_TOKEN "${token}"   (abra novo terminal depois)`);
  else console.log(`  export RBLX_MCP_TOKEN="${token}"   (adicione ao ~/.bashrc ou ~/.zshrc p/ persistir)`);
  console.log("\nPróximos passos:");
  if (/127\.0\.0\.1|localhost/.test(bridge)) {
    console.log("  0. rblx-mcp bridge     → sobe o bridge local (outro terminal, deixe rodando)");
  }
  console.log("  1. rblx-mcp plugin     → instala o plugin no Studio");
  console.log("  2. Cole o token acima no plugin e clique Connect");
  console.log("  3. rblx-mcp doctor     → confere se está tudo online");
}

async function cmdBridge(f) {
  // Sobe o bridge no próprio PC (modo local, sem Redis/Render).
  const port = String(f.port || process.env.PORT || "3000");
  const serverDir = path.resolve(__dirname, "..", "..", "server");
  if (!fs.existsSync(path.join(serverDir, "package.json"))) {
    throw new Error(`server/ não encontrado em ${serverDir} — reinstale o pacote rblx-mcp`);
  }
  const env = { ...process.env, PORT: port };
  if (f.redis) env.REDIS_URL = String(f.redis);
  if (f.store) env.STORE = String(f.store);
  if (!fs.existsSync(path.join(serverDir, "node_modules"))) {
    console.log("Instalando dependências do bridge (só na primeira vez)...");
    execSync(`npm --prefix "${serverDir}" install --no-audit --no-fund`, { stdio: "inherit" });
  }
  if (!fs.existsSync(path.join(serverDir, "dist", "index.js"))) {
    console.log("Compilando o bridge...");
    execSync(`npm --prefix "${serverDir}" run build`, { stdio: "inherit" });
  }
  const backend = env.STORE || (env.REDIS_URL ? "redis (REDIS_URL)" : "memory (local)");
  console.log(`Bridge em http://127.0.0.1:${port} — backend: ${backend}. Ctrl+C para parar.`);
  const r = spawnSync(process.execPath, [path.join(serverDir, "dist", "index.js")], {
    stdio: "inherit",
    env,
  });
  if (r.error) throw r.error;
  process.exitCode = r.status ?? 0;
}

async function cmdDoctor(f) {
  const saved = loadConfig();
  const bridge = normBridge(f.bridge || saved.bridge || (await ask("URL do bridge", "http://127.0.0.1:3000")));
  const token = f.token || saved.token || (await ask("Token (vazio p/ só testar /health)"));

  const health = await api(bridge, "/health");
  console.log(`✓ bridge online: ${JSON.stringify(health)}`);
  if (!token) return;

  try {
    const { sessions } = await api(bridge, "/api/commands/sessions", { token });
    console.log(`✓ auth ok — Studios conectados: ${sessions.length}`);
    for (const s of sessions) console.log(`  - ${s.place || "?"} (job ${s.jobId || "?"}) @ ${s.lastSeen}`);
    if (sessions.length === 0) console.log("  ! Nenhum Studio com poll ativo — abra o Studio e clique Connect.");
  } catch (e) {
    console.log(`✗ auth falhou: ${e.message}`);
  }
}

async function cmdPlugin(f) {
  const repo = f.repo || DEFAULT_REPO;
  if (!repo || !repo.includes("/")) {
    throw new Error("Repo inválido — use --repo usuario/nome ou RBLX_MCP_REPO=usuario/nome");
  }
  const url = `https://raw.githubusercontent.com/${repo}/main/plugin/PluginMain.lua`;
  console.log(`Baixando ${url} ...`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} — confira --repo e se o push foi feito`);
  const lua = await res.text();
  if (!/mcp-bridge|RblxMcpSessionToken/i.test(lua)) throw new Error("Conteúdo inesperado — confira o repo/branch.");

  const out =
    f.out ||
    (process.platform === "win32"
      ? path.join(process.env.LOCALAPPDATA || "", "Roblox", "Plugins", "StudioMcpBridge.lua")
      : path.join(os.homedir(), "Documents", "Roblox", "Plugins", "StudioMcpBridge.lua"));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, lua);
  console.log(`✓ plugin instalado em:\n  ${out}`);
  console.log("Reinicie o Studio → toolbar 'MCP Bridge' → clique Connect (com o token da sessão).");
}

function help() {
  console.log(`rblx-mcp — instala e configura o Rblx MCP

Instalação (1 comando):
  npm i -g https://github.com/tobyxxzz/Rblx_Mcp/releases/download/v0.2.1/rblx-mcp-0.2.1.tgz

Comandos:
  init [--bridge URL] [--token T] [--scope local|project|user] [--no-claude]
      Guia interativo: cria sessão e configura OpenCode + Claude Code/Desktop
  bridge [--port 3000] [--store memory|redis] [--redis URL]
      Sobe o bridge no próprio PC (modo local, sem Render/Redis)
  session [--bridge URL] [--advanced]
      Só cria uma sessão e mostra o token
  doctor [--bridge URL] [--token T]
      Testa /health, auth e lista Studios conectados
  plugin [--repo usuario/nome] [--out CAMINHO]
      Baixa o plugin do Studio p/ a pasta de plugins
  help
      Esta ajuda

Exemplos:
  rblx-mcp bridge                        (bridge local em http://127.0.0.1:3000)
  rblx-mcp init --bridge http://127.0.0.1:3000
  rblx-mcp init --bridge https://rblxmcp.onrender.com   (modo remoto)
  rblx-mcp doctor
`);
}

// ---------- main ----------
(async () => {
  const [, , cmd = "help", ...rest] = process.argv;
  const f = flags(rest);
  try {
    if (cmd === "init") await cmdInit(f);
    else if (cmd === "bridge") await cmdBridge(f);
    else if (cmd === "session") await cmdSession(f);
    else if (cmd === "doctor") await cmdDoctor(f);
    else if (cmd === "plugin") await cmdPlugin(f);
    else help();
  } catch (e) {
    console.error(`\nErro: ${e.message}`);
    process.exitCode = 1;
  }
})();
