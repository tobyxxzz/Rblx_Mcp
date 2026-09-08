# Rblx MCP — controle o Roblox Studio pela IA

Peça em português e veja acontecer no Studio: *"crie uma Part azul chamada Pódio no Workspace"*, *"leia os erros do Output"*, *"mude a Transparency da Baseplate pra 0.5"*.

O **Rblx MCP** é uma ponte entre assistentes de IA (Claude Code, OpenCode, Claude Desktop) e o Roblox Studio, pelo protocolo MCP. A IA enxerga seus lugares abertos, cria Parts e Scripts, altera propriedades e lê o Output — tudo sem você copiar e colar código.

```
Você fala ──► IA (Claude Code / OpenCode)
                    │  MCP
                    ▼
              Bridge (no seu PC ou na nuvem)
                    │  fila de comandos
                    ▼
              Plugin no Studio ──► executa no jogo
```

## Requisitos

- **Node 18+** (`node --version`)
- **Roblox Studio** com acesso à internet liberado:
  `Game Settings → Security → Enable Studio Access to APIs` + `HttpService.HttpEnabled = true`
- Uma CLI de IA: [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [OpenCode](https://opencode.ai) ou Claude Desktop

## Instalação rápida (modo local, recomendado)

Tudo no seu PC — sem conta, sem servidor, sem Redis:

```powershell
npm i -g https://github.com/tobyxxzz/Rblx_Mcp/releases/download/v0.2.0/rblx-mcp-0.2.0.tgz
rblx-mcp bridge
```

Deixe o bridge rodando e, **em outro terminal**:

```powershell
rblx-mcp init --bridge http://127.0.0.1:3000
rblx-mcp plugin
rblx-mcp doctor
```

O que cada comando faz:

| Comando | Pra que serve |
|---|---|
| `rblx-mcp bridge` | Sobe o bridge local (`http://127.0.0.1:3000`). Instala e compila sozinho na 1ª vez |
| `rblx-mcp init` | Cria sua sessão e configura sozinho OpenCode, Claude Code e Claude Desktop |
| `rblx-mcp plugin` | Baixa o plugin do Studio pra pasta certa |
| `rblx-mcp doctor` | Confere bridge + login + Studios conectados |
| `rblx-mcp session` | Cria uma sessão avulsa (mostra o token) |

## Conectando o Studio

1. Reinicie o Studio após o `rblx-mcp plugin` → aparece a toolbar **MCP Bridge**.
2. Cole o token da sessão (mostrado pelo `init`) e clique em **Connect**.
3. Volte na IA e peça: *"liste as sessões conectadas"* — seu lugar deve aparecer.
4. Teste: *"crie uma Part azul chamada Teste no Workspace"*.

Cada pessoa usa seu próprio token/sessão — dá pra ter vários Studios conectados ao mesmo tempo.

## Modo remoto (bridge na nuvem)

Pra usar a IA de outra máquina, aponte pro bridge público em vez do local:

```powershell
rblx-mcp init --bridge https://rblxmcp.onrender.com
```

> No plano gratuito o primeiro comando do dia pode demorar ~50s (cold start). Depois disso é instantâneo.

## O que a IA consegue fazer

| Leitura | Escrita | Avançada (opt-in) |
|---|---|---|
| `list_sessions` (Studios online) | `create_part` | `execute_luau` |
| `get_place_info` | `set_property` / `set_properties` | |
| `list_children`, `get_children_of_class` | `create_script`, `set_script_source` | |
| `get_properties`, `get_script_source` | `rename_object`, `clone_object` | |
| `get_output_logs` (erros de runtime) | `delete_object` | |
| `get_selection`, `ping`, `studio_ping` | | |

Fluxo típico: `list_sessions` → age no alvo → `get_output_logs` pra conferir se quebrou algo.

O `execute_luau` (rodar código arbitrário) vem **desligado por padrão** e só aparece pra sessão depois de um opt-in humano:

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:3000/api/commands/mode `
  -Headers @{ Authorization = "Bearer SEU_TOKEN" } `
  -ContentType "application/json" -Body '{"advanced":true}'
```

## Solução de problemas

| Sintoma | O que fazer |
|---|---|
| `Timeout: plugin da sessão não respondeu` | Studio offline, token diferente ou URL errada no plugin |
| Erro de auth / `401` | Token expirou (dura 24h) — crie outra sessão com `rblx-mcp session` |
| `roblox-bridge` não aparece na IA | Reinicie a sessão da CLI após o `init`; confira com `claude mcp list` / `opencode mcp list` |
| `403` no `execute_luau` | Normal: é opt-in (seção acima) |

Tutoriais passo a passo: [`docs/opencode.md`](docs/opencode.md) · [`docs/claude-code.md`](docs/claude-code.md)

## Segurança (resumo)

- Token aleatório por sessão (24h), guardado como hash — nunca em texto puro.
- Rate limit por sessão e por IP; headers reforçados com `helmet`.
- `Source` de scripts só muda via `set_script_source` (com limite de tamanho); `set_property` não aceita.
- Blocklist barra `game:Shutdown`, `os.*`, `io.*`, `require(id)` e afins no modo avançado.
- `GET /api/commands/history` audita tudo que a IA fez na sua sessão.

## Estrutura do repo

```
cli/        → instalador (init/bridge/session/doctor/plugin)
plugin/     → PluginMain.lua (toolbar do Studio) + script de teste rápido
server/src/ → bridge: REST + MCP/SSE (memory local ou Redis remoto)
mcpb/       → pacote one-click pro Claude Desktop (npm run build:mcpb)
docs/       → tutoriais por CLI · examples/ → JSONs e script de teste
```

Subindo o próprio bridge remoto: `server/` + Redis (ver `.env.example`; no Render, só `REDIS_URL` já ativa o modo Redis).
