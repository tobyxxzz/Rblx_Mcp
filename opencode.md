# Usando o Rblx MCP no OpenCode

O OpenCode não tem comando de "baixar MCP" — o jeito nativo é declarar o
servidor no `opencode.json`. Este guia mostra os 2 caminhos.

## Pré-requisitos

- Bridge no ar (local ou `https://seu-bridge.onrender.com`) — confira com
  `https://SEU-BRIDGE/health` → `{"ok":true}`
- Um token de sessão (veja abaixo)
- Plugin do Studio conectado (senão as tools respondem timeout)

## Opção A — automática (recomendada)

```powershell
npm i -g github:SEU-USUARIO/Rblx_Mcp
rblx-mcp init --bridge https://SEU-BRIDGE
```

O assistente cria a sessão, escreve o bloco `mcp` no `opencode.json` do
diretório atual e mostra o comando p/ exportar o token. Pule para
[Verificando](#verificando).

## Opção B — manual

**1. Crie a sessão** (gera o token do Usuário A/B):

```powershell
$BASE = "https://SEU-BRIDGE"
$sess = Invoke-RestMethod -Method Post "$BASE/api/auth/session"
$sess.token   # guarde este valor
```

**2. Exporte o token como variável de ambiente** (não cole no JSON —
`opencode.json` costuma ir p/ git):

```powershell
# Windows (abra um NOVO terminal depois):
setx RBLX_MCP_TOKEN "SEU_TOKEN"

# macOS / Linux (adicione ao ~/.bashrc ou ~/.zshrc p/ persistir):
export RBLX_MCP_TOKEN="SEU_TOKEN"
```

**3. Adicione ao `opencode.json`** (na raiz do projeto):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "roblox-bridge": {
      "type": "remote",
      "url": "https://SEU-BRIDGE/mcp/sse",
      "enabled": true,
      "oauth": false,
      "headers": {
        "Authorization": "Bearer {env:RBLX_MCP_TOKEN}"
      }
    }
  }
}
```

> Por que `oauth: false`? Sem isso o OpenCode tenta iniciar um fluxo OAuth
> ao receber nosso `401`, em vez de usar o Bearer direto.

**4. Reinicie o OpenCode** (ou recarregue a sessão) no mesmo terminal onde
a variável foi exportada.

## Verificando

1. Rode `opencode mcp list` — `roblox-bridge` deve aparecer conectado.
2. Peça algo simples: *"liste as sessões conectadas"* (tool `list_sessions`).
   Se voltar `[]`, o Studio não está com poll ativo — abra o Studio e clique **Connect**.
3. Teste escrita: *"crie uma Part azul chamada Teste no Workspace"*.
4. Confira erros de runtime com *"leia o output do Studio"* (`get_output_logs`).

## Problemas comuns

| Sintoma | O que fazer |
|---|---|
| Tools não aparecem | `RBLX_MCP_TOKEN` exportada no terminal atual? `oauth: false` presente? Reiniciou o OpenCode após editar o JSON? |
| Erro de auth / 401 | Token expirado (padrão 24h) — crie outra sessão e atualize a env |
| `Timeout: plugin da sessão não respondeu` | Plugin offline, URL errada no plugin ou token diferente do Studio |
| Resposta lenta na 1ª chamada (Render free) | Cold start (~50s) — normal, só na primeira |

## Indo além

- **Modo avançado** (`execute_luau` não aparece por padrão — é opt-in):
  `POST /api/commands/mode {"advanced":true}` com seu Bearer, depois reconecte.
- **Vários Studios**: cada um com seu token; a IA alterna passando `sessionId`.
- Detalhes de segurança e todas as tools: veja o `README.md` principal.
