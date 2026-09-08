# Teste rápido do bridge via REST (sem IA), PowerShell:
# 1. Crie uma sessão (retorna sessionId + token)
# 2. Coloque o TOKEN no plugin/Studio e aperte Connect
# 3. Envie comandos por aqui e veja o Studio executar

$BASE = "http://127.0.0.1:3000"

# criar sessão
$sess = Invoke-RestMethod -Method Post "$BASE/api/auth/session"
$sess
$TOKEN = $sess.token
$H = @{ Authorization = "Bearer $TOKEN" }

# ping (o plugin precisa estar com poll ativo)
Invoke-RestMethod -Method Post "$BASE/api/commands/send" -Headers $H `
  -ContentType "application/json" `
  -Body '{"type":"ping","payload":{}}'

# info do lugar
Invoke-RestMethod -Method Post "$BASE/api/commands/send" -Headers $H `
  -ContentType "application/json" `
  -Body '{"type":"get_place_info","payload":{}}'

# criar uma part
Invoke-RestMethod -Method Post "$BASE/api/commands/send" -Headers $H `
  -ContentType "application/json" `
  -Body '{"type":"create_part","payload":{"name":"McpTeste","position":[0,10,0],"size":[4,1,2],"color":[0,170,255]}}'

# listar Workspace
Invoke-RestMethod -Method Post "$BASE/api/commands/send" -Headers $H `
  -ContentType "application/json" `
  -Body '{"type":"list_children","payload":{"path":"Workspace"}}'

# ler propriedades
Invoke-RestMethod -Method Post "$BASE/api/commands/send" -Headers $H `
  -ContentType "application/json" `
  -Body '{"type":"get_properties","payload":{"path":"Workspace.McpTeste"}}'

# criar script
Invoke-RestMethod -Method Post "$BASE/api/commands/send" -Headers $H `
  -ContentType "application/json" `
  -Body '{"type":"create_script","payload":{"name":"McpHello","parent":"ServerScriptService","source":"print(\"hello via MCP\")"}}'

# ler código do script
Invoke-RestMethod -Method Post "$BASE/api/commands/send" -Headers $H `
  -ContentType "application/json" `
  -Body '{"type":"get_script_source","payload":{"path":"ServerScriptService.McpHello"}}'

# auditoria da sessão
Invoke-RestMethod -Method Get "$BASE/api/commands/history?limit=10" -Headers $H

# studios conectados (presença via poll do plugin)
Invoke-RestMethod -Method Get "$BASE/api/commands/sessions" -Headers $H

# batch de propriedades (1 round-trip em vez de N)
Invoke-RestMethod -Method Post "$BASE/api/commands/send" -Headers $H `
  -ContentType "application/json" `
  -Body '{"type":"set_properties","payload":{"path":"Workspace.McpTeste","properties":{"Transparency":0.5,"Anchored":true}}}'

# output do Studio (erros de runtime)
Invoke-RestMethod -Method Post "$BASE/api/commands/send" -Headers $H `
  -ContentType "application/json" `
  -Body '{"type":"get_output_logs","payload":{"max":20,"filter":"errors"}}'

# filhos filtrados por classe
Invoke-RestMethod -Method Post "$BASE/api/commands/send" -Headers $H `
  -ContentType "application/json" `
  -Body '{"type":"get_children_of_class","payload":{"path":"Workspace","class":"Part"}}'

# modo avançado (opt-in do execute_luau — ação humana)
Invoke-RestMethod -Method Post "$BASE/api/commands/mode" -Headers $H `
  -ContentType "application/json" `
  -Body '{"advanced":true}'
