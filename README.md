# Rblx MCP — CLI de IA → Seu site → Plugin no Studio

Scaffold do diagrama que você mandou:

```
CLI de IA (Claude Code, OpenCode)
        │  SSE remoto + Bearer
        ▼
Seu site (este repo: servidor MCP + bridge)
   ├─ Autenticação ─ token por sessão, hash sha256 no Redis (POST /api/auth/session)
   ├─ Fila de comandos ─ Redis (queue:{sessão} / result:{id}) + auditoria
   ├─ Segurança ─ helmet, rate limit por sessão/IP, guards de Luau
   └─ Transporte MCP ─ SSE remoto (GET /mcp/sse)
        │ long-poll
        ▼
Plugin no Studio — Usuário A / Usuário B (um token por sessão)
```

## Instalação em 1 comando (usuário final)

Pré-requisito: Node 18+ e o bridge já no ar (ou local).

```powershell
npm i -g github:tobyxxzz/Rblx_Mcp
rblx-mcp init --bridge https://rblxmcp.onrender.com
```

O `init` é interativo: cria a sessão, salva o token e configura
sozinho **OpenCode** (`opencode.json`), **Claude Code** (`claude mcp add`,
com fallback p/ `.mcp.json`) e **Claude Desktop**. Depois:

```powershell
rblx-mcp plugin    # baixa o plugin p/ a pasta do Studio
rblx-mcp doctor    # confere bridge + auth + Studios conectados
```

Se forkar o repo, aponte p/ outro endereço com `RBLX_MCP_REPO=voce/repo`.
Quem preferir o manual: seções abaixo.

**Tutoriais passo a passo:** [`docs/opencode.md`](docs/opencode.md) ·
[`docs/claude-code.md`](docs/claude-code.md)

## Instalação nativa por CLI (sem o instalador)

Cada CLI tem seu sistema próprio — o `rblx-mcp init` acima só automatiza estes passos:

- **Claude Code** (tem `mcp add` de verdade):
  ```powershell
  claude mcp add --transport sse roblox-bridge https://rblxmcp.onrender.com/mcp/sse --header "Authorization: Bearer SEU_TOKEN"
  # scopes: --scope local|project|user | ver: claude mcp list | remover: claude mcp remove roblox-bridge
  ```
- **OpenCode** (não tem `mcp add`; o nativo é o bloco `mcp` no `opencode.json`):
  ```json
  { "mcp": { "roblox-bridge": {
    "type": "remote", "url": "https://rblxmcp.onrender.com/mcp/sse",
    "enabled": true, "oauth": false,
    "headers": { "Authorization": "Bearer {env:RBLX_MCP_TOKEN}" }
  } } }
  ```
  Exporte o token (`setx RBLX_MCP_TOKEN "..."` no Windows) em vez de colar no JSON,
  que costuma ir p/ git. Gerenciar: `opencode mcp list`.
- **Claude Desktop** (só aceita servidor **local**, não SSE remoto) — 2 caminhos:
  1. `rblx-mcp init` escreve o proxy `mcp-remote` no config (precisa de Node/npx).
  2. **One-click**: `npm run build:mcpb` gera `dist/rblx-mcp.mcpb` — abra o arquivo
     com o Desktop, preencha URL + token e pronto (sem JSON manual).

## Como funciona (passo a passo)

1. **Sessão:** `POST /api/auth/session` → `{ sessionId, token }`. Um por usuário.
2. **Plugin:** cada Studio cola seu token e faz `GET /api/commands/next` em loop
   (long-poll de ~25s via `BRPOP`). Sem comando → volta a perguntar.
3. **IA:** Claude Code/OpenCode conecta em `GET /mcp/sse` com
   `Authorization: Bearer <token>` e vê as tools (`create_part`, `set_property`…).
4. **Tool call:** o servidor faz `LPUSH queue:{sessão}` e fica bloqueado em
   `BRPOP result:{id}` esperando o plugin (até 25s).
5. **Execução:** o plugin executa o Luau no Studio e dá
   `POST /api/commands/result { id, ok, data }`.
6. **Resposta:** o servidor desbloqueia e devolve o resultado à IA via MCP.

## Rodar local

```powershell
docker compose up -d        # sobe o Redis
copy .env.example .env
npm install
npm run dev                 # bridge em http://localhost:3000
```

## Ligar o Studio

1. No Studio: **Game Settings → Security → Enable Studio Access to APIs** +
   selecione o `HttpService` e marque `HttpEnabled = true`.
2. Teste rápido: ponha `plugin/StudioMcpBridge.server.lua` em
   **ServerScriptService**, crie os Attributes `BRIDGE_URL` =
   `http://127.0.0.1:3000` e `TOKEN` = token da sessão, aperte **Play** (ou Run).
3. Versão definitiva: salve `plugin/PluginMain.lua` em
   `%LOCALAPPDATA%\Roblox\Plugins\StudioMcpBridge.lua`, reinicie o Studio,
   defina o token (variável `SET_TOKEN` uma vez) e clique em **Connect**.
4. Teste: rode `examples/test_bridge.ps1` — o Studio deve criar a Part.

## Conectar a IA

- **OpenCode:** copie `examples/opencode.json` (troque URL + token).
- **Claude Code:** `claude mcp add --transport sse roblox-bridge <URL>/mcp/sse --header "Authorization: Bearer <TOKEN>"`
  (ver `examples/claude_mcp.json`).

## Tools disponíveis (18 + 1 opt-in)

Leitura: `ping`, `studio_ping`, `get_place_info`, `list_children`,
`get_children_of_class`, `get_properties`, `get_script_source`,
`get_output_logs`, `get_selection`, `list_sessions`.
Escrita: `create_part`, `set_property`, `set_properties` (batch),
`create_script`, `set_script_source`, `rename_object`, `clone_object`,
`delete_object`.
Avançada (opt-in): `execute_luau` — só aparece na lista se a sessão
ativar o modo avançado (humano, via REST):

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:3000/api/commands/mode `
  -Headers @{ Authorization = "Bearer SEU_TOKEN" } `
  -ContentType "application/json" -Body '{"advanced":true}'
```

Fluxo sugerido à IA: `list_sessions` → escolhe o alvo → age →
`get_output_logs` p/ conferir erros.

## Segurança

- **Tokens:** `POST /api/auth/session` gera token aleatório com TTL
  (`SESSION_TTL_HOURS`, padrão 24h). No Redis fica só o `sha256(token)` —
  um dump do banco não vaza credenciais. Token desconhecido = `401`
  (o atalho antigo `token == sessionId` só volta com `ALLOW_SELF_SESSION=1`).
- **Rate limit:** 120 req/min por sessão nas rotas `/api/commands`
  (`RATE_LIMIT_MAX`), 10 sessões/min por IP (`AUTH_LIMIT_MAX`),
  300 msg/min por IP no `/mcp/messages`. Atrás de proxy: `TRUST_PROXY=1`.
- **Headers + CORS:** `helmet` ligado; sem `CORS_ORIGIN` não há headers CORS
  (clientes MCP são server-side e não precisam).
- **Guards de conteúdo** (valem p/ MCP **e** REST, antes de enfileirar):
  `ALLOW_EXECUTE_LUAU=0` desliga a tool globalmente; por padrão ela ainda
  exige opt-in por sessão (`ADVANCED_DEFAULT=0`, `POST /api/commands/mode`);
  blocklist bloqueia `game:Shutdown`,
  `os.*`, `io.*`, `writefile`, `require(id)` etc. (`LUAU_BLOCKLIST_EXTRA`
  adiciona padrões); `MAX_LUAU_BYTES` (20KB) e `MAX_SOURCE_BYTES` (200KB).
- **Auditoria:** `GET /api/commands/history` mostra os últimos comandos da
  sua sessão (ok/erro) — útil p/ ver o que a IA fez.
- **HTTPS:** em produção o TLS termina no provedor (Railway/Fly/Nginx).
  Nunca exponha o Redis na internet.

Limitações conhecidas: `execute_luau` com loop infinito trava o poll do
plugin (reinicie o Studio); `get_selection` só funciona no plugin em
modo Edit; sessões criadas antes do hash de token deixam de valer.

## Deploy (resumo)

- Suba `server/` em Railway/Render/Fly + Redis gerenciado (Upstash).
- `npm install` no deploy (novas deps: `helmet`, `express-rate-limit`).
- Troque `http://127.0.0.1:3000` pela URL pública no plugin e na config da IA.
- Defina as variáveis do `.env.example` no painel do provedor
  (`TRUST_PROXY=1`, `CORS_ORIGIN` só se tiver painel web).

## Estrutura

```
server/src/index.ts  → Express + rotas REST + monta /mcp
server/src/mcp.ts    → 19 tools MCP (18 + execute_luau opt-in) + SSE remoto
server/src/auth.ts   → token por sessão (hash sha256, TTL)
server/src/security.ts → helmet, rate limits, guards de Luau, modo avançado
server/src/queue.ts  → fila Redis (enqueue/wait, poll, result, auditoria, presença)
server/src/redis.ts  → conexão
cli/bin/rblx-mcp.js  → instalador (init/session/doctor/plugin)
mcpb/                → bundle one-click p/ Claude Desktop (manifest + proxy)
docs/opencode.md     → tutorial OpenCode
docs/claude-code.md  → tutorial Claude Code
plugin/StudioMcpBridge.server.lua → teste rápido
plugin/PluginMain.lua             → plugin com toolbar
examples/ → opencode.json, claude_mcp.json, test_bridge.ps1
```
