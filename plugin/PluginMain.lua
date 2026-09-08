-- PluginMain.lua
-- Plugin real (Usuário A / Usuário B): toolbar com Connect/Disconnect.
-- Instalação: Studio > Plugins > Plugin Management > ... ou salve em
-- %LOCALAPPDATA%\Roblox\Plugins\StudioMcpBridge.lua e reinicie o Studio.
-- Configure BRIDGE_URL e TOKEN abaixo (um token por usuário/sessão).

local BRIDGE_URL = "http://127.0.0.1:3000"
local TOKEN_KEY = "RblxMcpSessionToken"

local HttpService = game:GetService("HttpService")
local toolbar = plugin:CreateToolbar("MCP Bridge")
local connectBtn = toolbar:CreateButton("Connect", "Conecta este Studio à fila MCP", "rbxassetid://0")
connectBtn.ClickableWhenViewportHidden = true

local running = false

local function getToken(): string
	return plugin:GetSetting(TOKEN_KEY) or "SEU_TOKEN_DE_SESSAO"
end

-- Troque o token: Plugins > (este plugin salva via SetSetting).
-- Atalho rápido: execute na Command Bar:
--   plugin:GetSetting("RblxMcpSessionToken") -- ver
-- Para definir, rode este arquivo uma vez com SET_TOKEN preenchido:
local SET_TOKEN = "" -- ex: "abc-123" depois apague
if SET_TOKEN ~= "" then
	plugin:SetSetting(TOKEN_KEY, SET_TOKEN)
	warn("[mcp-bridge] token salvo. Apague o SET_TOKEN e reinicie.")
end

local function headers()
	return {
		["Content-Type"] = "application/json",
		["Authorization"] = "Bearer " .. getToken(),
	}
end

local function resolvePath(path: string): Instance?
	if not path or path == "" then return nil end
	local parts = string.split(path, ".")
	local first = parts[1]
	local current: Instance?
	local ok, svc = pcall(game.GetService, game, first)
	current = (first == "game" and game) or (ok and svc) or game:FindFirstChild(first)
	table.remove(parts, 1)
	for _, name in ipairs(parts) do
		if not current then return nil end
		current = current:FindFirstChild(name)
	end
	return current
end

-- Serializa valores p/ JSON (Vector3/Color3/Instance quebram o JSONEncode)
local function ser(v)
	local t = typeof(v)
	if v == nil or t == "string" or t == "number" or t == "boolean" then
		return v
	elseif t == "Instance" then
		return v:GetFullName()
	elseif t == "table" then
		local out = {}
		for k, item in pairs(v) do
			out[k] = ser(item)
		end
		return out
	else
		return tostring(v) -- Vector3, Color3, CFrame, UDim2, EnumItem, BrickColor...
	end
end

local SAFE_PROPS = {
	"Name", "ClassName", "Archivable",
	"Transparency", "Reflectance", "Anchored", "CanCollide", "CanQuery", "CanTouch",
	"Material", "Shape", "Size", "Position", "Orientation", "Color",
	"Enabled", "Disabled", "Visible", "Text", "Value", "RunContext",
}

local function execCommand(cmd)
	local t = cmd.type
	local p = cmd.payload or {}
	if t == "ping" then
		return { pong = true, place = game.Name }
	elseif t == "get_place_info" then
		return { name = game.Name, placeId = game.PlaceId, jobId = game.JobId }
	elseif t == "list_children" then
		local root = resolvePath(p.path or "Workspace")
		if not root then error("path não encontrado: " .. tostring(p.path)) end
		local out = {}
		for _, c in ipairs(root:GetChildren()) do
			table.insert(out, { name = c.Name, class = c.ClassName, path = c:GetFullName() })
		end
		return { path = root:GetFullName(), count = #out, children = out }
	elseif t == "create_part" then
		local pos = p.position or { 0, 10, 0 }
		local size = p.size or { 4, 1, 2 }
		local col = p.color or { 0, 170, 255 }
		local part = Instance.new("Part")
		part.Name = p.name or "McpPart"
		part.Size = Vector3.new(size[1], size[2], size[3])
		part.Position = Vector3.new(pos[1], pos[2], pos[3])
		part.Color = Color3.fromRGB(col[1], col[2], col[3])
		part.Anchored = true
		part.Parent = workspace
		return { path = part:GetFullName() }
	elseif t == "set_property" then
		local obj = resolvePath(p.path)
		if not obj then error("path não encontrado") end
		if type(p.property) ~= "string" or p.property == "" then error("property inválida") end
		if string.lower(p.property) == "source" then error("use set_script_source p/ alterar Source") end
		obj[p.property] = p.value
		return { ok = true }
	elseif t == "delete_object" then
		local obj = resolvePath(p.path)
		if not obj then error("path não encontrado: " .. tostring(p.path)) end
		local full = obj:GetFullName()
		obj:Destroy()
		return { deleted = full }
	elseif t == "get_properties" then
		local obj = resolvePath(p.path)
		if not obj then error("path não encontrado: " .. tostring(p.path)) end
		local out = { path = obj:GetFullName(), class = obj.ClassName }
		for _, name in ipairs(SAFE_PROPS) do
			local ok, v = pcall(function() return obj[name] end)
			if ok then
				local s = ser(v)
				if s ~= nil then out[name] = s end
			end
		end
		return out
	elseif t == "get_script_source" then
		local obj = resolvePath(p.path)
		if not obj then error("path não encontrado: " .. tostring(p.path)) end
		if not obj:IsA("LuaSourceContainer") then error("não é script: " .. obj.ClassName) end
		return { path = obj:GetFullName(), source = obj.Source }
	elseif t == "set_script_source" then
		local obj = resolvePath(p.path)
		if not obj then error("path não encontrado: " .. tostring(p.path)) end
		if not obj:IsA("LuaSourceContainer") then error("não é script: " .. obj.ClassName) end
		obj.Source = p.source
		return { path = obj:GetFullName(), bytes = #(p.source or "") }
	elseif t == "create_script" then
		local class = p.class or "Script"
		if class ~= "Script" and class ~= "LocalScript" and class ~= "ModuleScript" then
			error("class inválida: " .. tostring(class))
		end
		local parent = resolvePath(p.parent or "ServerScriptService")
		if not parent then error("parent não encontrado: " .. tostring(p.parent)) end
		local s = Instance.new(class)
		s.Name = p.name or "McpScript"
		s.Source = p.source or ""
		s.Parent = parent
		return { path = s:GetFullName() }
	elseif t == "rename_object" then
		local obj = resolvePath(p.path)
		if not obj then error("path não encontrado") end
		obj.Name = p.name
		return { path = obj:GetFullName() }
	elseif t == "clone_object" then
		local obj = resolvePath(p.path)
		if not obj then error("path não encontrado") end
		if not obj.Archivable then error("objeto não clonável") end
		local parent = obj.Parent
		if p.parent and p.parent ~= "" then
			parent = resolvePath(p.parent)
			if not parent then error("parent destino não encontrado") end
		end
		local c = obj:Clone()
		c.Parent = parent
		return { path = c:GetFullName() }
	elseif t == "get_selection" then
		local out = {}
		for _, inst in ipairs(game:GetService("Selection"):Get()) do
			table.insert(out, { name = inst.Name, class = inst.ClassName, path = inst:GetFullName() })
		end
		return { count = #out, selection = out }
	elseif t == "set_properties" then
		local obj = resolvePath(p.path)
		if not obj then error("path não encontrado: " .. tostring(p.path)) end
		local applied, failed = {}, {}
		for k, v in pairs(p.properties or {}) do
			if string.lower(tostring(k)) == "source" then
				failed[k] = "use set_script_source p/ alterar Source"
			else
				local ok, err = pcall(function() obj[k] = v end)
				if ok then applied[k] = v else failed[k] = tostring(err) end
			end
		end
		return { path = obj:GetFullName(), applied = ser(applied), failed = failed }
	elseif t == "get_output_logs" then
		local max = math.min(tonumber(p.max) or 100, 500)
		local onlyErrors = p.filter == "errors"
		local hist = game:GetService("LogService"):GetLogHistory()
		local out = {}
		local start = math.max(1, #hist - max + 1)
		for i = start, #hist do
			local e = hist[i]
			local mt = tostring(e.messageType)
			if not onlyErrors or (mt:find("Error") or mt:find("Warning")) then
				local msg = e.message or ""
				if #msg > 500 then msg = string.sub(msg, 1, 500) .. "...(cortado)" end
				table.insert(out, { type = mt, message = msg, timestamp = e.timestamp })
			end
		end
		return { count = #out, logs = out }
	elseif t == "get_children_of_class" then
		local root = resolvePath(p.path or "Workspace")
		if not root then error("path não encontrado: " .. tostring(p.path)) end
		local class = p.class or "Part"
		local out = {}
		for _, c in ipairs(root:GetChildren()) do
			if c:IsA(class) then
				table.insert(out, { name = c.Name, class = c.ClassName, path = c:GetFullName() })
			end
		end
		return { path = root:GetFullName(), class = class, count = #out, children = out }
	elseif t == "execute_luau" then
		local fn, err = loadstring(p.code or "return nil")
		if not fn then error(tostring(err)) end
		return { returned = ser(fn()) }
	else
		error("tipo desconhecido: " .. tostring(t))
	end
end

local function pollUrl()
	return BRIDGE_URL .. "/api/commands/next"
		.. "?place=" .. HttpService:UrlEncode(game.Name)
		.. "&placeId=" .. tostring(game.PlaceId)
		.. "&jobId=" .. (game.JobId or "")
end

local function loop()
	while running do
		local ok, err = pcall(function()
			local res = HttpService:RequestAsync({
				Url = pollUrl(),
				Method = "GET",
				Headers = headers(),
			})
			if res.StatusCode ~= 200 then warn("[mcp-bridge] HTTP " .. res.StatusCode) task.wait(3) return end
			local body = HttpService:JSONDecode(res.Body)
			local cmd = body and body.command
			if not cmd then return end
			local cok, data = pcall(execCommand, cmd)
			local payload = cok
				and { id = cmd.id, ok = true, data = data }
				or { id = cmd.id, ok = false, error = tostring(data) }
			HttpService:RequestAsync({
				Url = BRIDGE_URL .. "/api/commands/result",
				Method = "POST",
				Headers = headers(),
				Body = HttpService:JSONEncode(payload),
			})
			print("[mcp-bridge] " .. cmd.type .. " ok=" .. tostring(cok))
		end)
		if not ok then warn("[mcp-bridge] " .. tostring(err)) task.wait(3) end
	end
end

connectBtn.Click:Connect(function()
	running = not running
	connectBtn:SetActive(running)
	print(running and "[mcp-bridge] conectado. Poll em " .. BRIDGE_URL or "[mcp-bridge] desconectado")
	if running then task.spawn(loop) end
end)
