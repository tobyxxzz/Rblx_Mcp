import type { Express, RequestHandler } from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { enqueueAndWait } from "./queue.js";
import { listPresence } from "./queue.js";
import { isAdvancedMode, envBool } from "./security.js";
import { requireAuth, type AuthedRequest } from "./auth.js";

// Liga transport.sessionId (MCP) -> studio session (plugin A/B)
const studioByTransport = new Map<string, string>();

const TOOLS: Tool[] = [
  {
    name: "ping",
    description: "Testa se o bridge MCP está online (não fala com o Studio).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "studio_ping",
    description: "Testa se o plugin do Studio da sessão responde.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string", description: "Sessão do plugin (opcional, usa a da conexão)" } },
    },
  },
  {
    name: "get_place_info",
    description: "Retorna nome do lugar/jogo no Studio.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" } },
    },
  },
  {
    name: "list_children",
    description: "Lista filhos de um serviço (ex: Workspace, ServerScriptService).",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        path: { type: "string", description: "Ex: Workspace (padrão)" },
      },
    },
  },
  {
    name: "create_part",
    description: "Cria uma Part no Workspace.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        name: { type: "string" },
        position: { type: "array", items: { type: "number" }, description: "[x,y,z]" },
        size: { type: "array", items: { type: "number" }, description: "[x,y,z]" },
        color: { type: "array", items: { type: "number" }, description: "[r,g,b] 0-255" },
      },
    },
  },
  {
    name: "set_property",
    description: "Altera propriedade de um objeto (ex: Workspace.Baseplate.Transparency = 0.5).",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        path: { type: "string" },
        property: { type: "string" },
        value: {},
      },
      required: ["path", "property", "value"],
    },
  },
  {
    name: "execute_luau",
    description: "OPT-IN (só aparece se a sessão ativou o modo avançado). Executa Luau arbitrário no Studio, use com cuidado.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        code: { type: "string", description: "Código Luau com 'return' opcional" },
      },
      required: ["code"],
    },
  },
  {
    name: "delete_object",
    description: "Deleta um objeto do Studio (ex: Workspace.McpTeste). Sem undo via API — use com cuidado.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        path: { type: "string", description: "Ex: Workspace.McpTeste" },
      },
      required: ["path"],
    },
  },
  {
    name: "get_properties",
    description: "Lê propriedades comuns de um objeto (Name, Class, Transparency, Position, etc).",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        path: { type: "string" },
      },
      required: ["path"],
    },
  },
  {
    name: "get_script_source",
    description: "Retorna o código-fonte de um Script/LocalScript/ModuleScript.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        path: { type: "string", description: "Ex: ServerScriptService.MeuScript" },
      },
      required: ["path"],
    },
  },
  {
    name: "set_script_source",
    description: "Substitui o código-fonte de um script (limite: MAX_SOURCE_BYTES).",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        path: { type: "string" },
        source: { type: "string" },
      },
      required: ["path", "source"],
    },
  },
  {
    name: "create_script",
    description: "Cria Script/LocalScript/ModuleScript com código-fonte.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        name: { type: "string" },
        class: { type: "string", description: "Script, LocalScript ou ModuleScript (padrão: Script)" },
        parent: { type: "string", description: "Serviço ou path (padrão: ServerScriptService)" },
        source: { type: "string" },
      },
      required: ["name"],
    },
  },
  {
    name: "rename_object",
    description: "Renomeia um objeto.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        path: { type: "string" },
        name: { type: "string", description: "Novo nome" },
      },
      required: ["path", "name"],
    },
  },
  {
    name: "clone_object",
    description: "Duplica um objeto (opcionalmente para outro parent).",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        path: { type: "string" },
        parent: { type: "string", description: "Path de destino (padrão: mesmo parent)" },
      },
      required: ["path"],
    },
  },
  {
    name: "get_selection",
    description: "Retorna o que está selecionado no Studio (só funciona no plugin, modo Edit).",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" } },
    },
  },
  {
    name: "set_properties",
    description: "Altera várias propriedades de uma vez (1 round-trip em vez de N). Retorna aplicadas + falhas por campo.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        path: { type: "string", description: "Ex: Workspace.McpTeste" },
        properties: { type: "object", description: "Dict propriedade -> valor" },
      },
      required: ["path", "properties"],
    },
  },
  {
    name: "get_output_logs",
    description: "Lê o Output do Studio (erros de runtime dos seus scripts). Essencial p/ depurar o que você criou.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        max: { type: "number", description: "Máx de linhas (padrão 100, teto 500)" },
        filter: { type: "string", description: "'all' ou 'errors' (só erros + warnings)" },
      },
    },
  },
  {
    name: "get_children_of_class",
    description: "Lista filhos já filtrados por classe (evita trazer a árvore inteira).",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        path: { type: "string", description: "Ex: Workspace (padrão)" },
        class: { type: "string", description: "Ex: Part, Script, Model" },
      },
      required: ["class"],
    },
  },
  {
    name: "list_sessions",
    description: "Lista Studios conectados no momento (sessionId, lugar, job). Use antes de agir p/ escolher o alvo.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

function pickSession(args: Record<string, unknown> | undefined, fallback: string): string {
  const s = args?.["sessionId"];
  if (typeof s !== "string" || s.length === 0) return fallback;
  // Isolamento entre sessoes: a IA so comanda o Studio da propria sessao.
  if (s !== fallback && !envBool("ALLOW_CROSS_SESSION", false)) {
    throw new Error("sessionId de outra sessao nao permitido - conecte com o token da sessao alvo");
  }
  return s;
}

export function createMcpServer(defaultStudioSession: string) {
  const server = new Server(
    { name: "rblx-mcp-bridge", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  // execute_luau é opt-in: só aparece p/ sessões em modo avançado.
  // Defesa em profundidade: o CallTool também valida (enqueueAndWait).
  server.setRequestHandler(ListToolsRequestSchema, async (_req, extra) => {
    const transportSession = (extra as { sessionId?: string }).sessionId ?? "";
    const studioSession = studioByTransport.get(transportSession) ?? defaultStudioSession;
    const advanced = await isAdvancedMode(studioSession);
    return { tools: advanced ? TOOLS : TOOLS.filter((t) => t.name !== "execute_luau") };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const { name, arguments: args } = req.params;
    const transportSession = (extra as { sessionId?: string }).sessionId ?? "";
    const studioSession =
      studioByTransport.get(transportSession) ?? defaultStudioSession;

    try {
      switch (name) {
        case "ping":
          return { content: [{ type: "text", text: "pong bridge-ok" }] };
        case "studio_ping": {
          const target = pickSession(args, studioSession);
          const r = await enqueueAndWait(target, "ping", {});
          return { content: [{ type: "text", text: JSON.stringify(r) }] };
        }
        case "get_place_info": {
          const target = pickSession(args, studioSession);
          const r = await enqueueAndWait(target, "get_place_info", {});
          return { content: [{ type: "text", text: JSON.stringify(r) }] };
        }
        case "list_children": {
          const target = pickSession(args, studioSession);
          const r = await enqueueAndWait(target, "list_children", {
            path: (args?.["path"] as string) ?? "Workspace",
          });
          return { content: [{ type: "text", text: JSON.stringify(r) }] };
        }
        case "create_part": {
          const target = pickSession(args, studioSession);
          const r = await enqueueAndWait(target, "create_part", {
            name: args?.["name"] ?? "McpPart",
            position: args?.["position"] ?? [0, 10, 0],
            size: args?.["size"] ?? [4, 1, 2],
            color: args?.["color"] ?? [0, 170, 255],
          });
          return { content: [{ type: "text", text: JSON.stringify(r) }] };
        }
        case "set_property": {
          const target = pickSession(args, studioSession);
          const r = await enqueueAndWait(target, "set_property", {
            path: args?.["path"],
            property: args?.["property"],
            value: args?.["value"],
          });
          return { content: [{ type: "text", text: JSON.stringify(r) }] };
        }
        case "execute_luau": {
          const target = pickSession(args, studioSession);
          const r = await enqueueAndWait(target, "execute_luau", {
            code: args?.["code"] ?? "return 1+1",
          });
          return { content: [{ type: "text", text: JSON.stringify(r) }] };
        }
        case "delete_object": {
          const target = pickSession(args, studioSession);
          const r = await enqueueAndWait(target, "delete_object", {
            path: args?.["path"],
          });
          return { content: [{ type: "text", text: JSON.stringify(r) }] };
        }
        case "get_properties": {
          const target = pickSession(args, studioSession);
          const r = await enqueueAndWait(target, "get_properties", {
            path: args?.["path"],
          });
          return { content: [{ type: "text", text: JSON.stringify(r) }] };
        }
        case "get_script_source": {
          const target = pickSession(args, studioSession);
          const r = await enqueueAndWait(target, "get_script_source", {
            path: args?.["path"],
          });
          return { content: [{ type: "text", text: JSON.stringify(r) }] };
        }
        case "set_script_source": {
          const target = pickSession(args, studioSession);
          const r = await enqueueAndWait(target, "set_script_source", {
            path: args?.["path"],
            source: args?.["source"],
          });
          return { content: [{ type: "text", text: JSON.stringify(r) }] };
        }
        case "create_script": {
          const target = pickSession(args, studioSession);
          const r = await enqueueAndWait(target, "create_script", {
            name: args?.["name"],
            class: args?.["class"] ?? "Script",
            parent: args?.["parent"] ?? "ServerScriptService",
            source: args?.["source"] ?? "",
          });
          return { content: [{ type: "text", text: JSON.stringify(r) }] };
        }
        case "rename_object": {
          const target = pickSession(args, studioSession);
          const r = await enqueueAndWait(target, "rename_object", {
            path: args?.["path"],
            name: args?.["name"],
          });
          return { content: [{ type: "text", text: JSON.stringify(r) }] };
        }
        case "clone_object": {
          const target = pickSession(args, studioSession);
          const r = await enqueueAndWait(target, "clone_object", {
            path: args?.["path"],
            parent: args?.["parent"],
          });
          return { content: [{ type: "text", text: JSON.stringify(r) }] };
        }
        case "get_selection": {
          const target = pickSession(args, studioSession);
          const r = await enqueueAndWait(target, "get_selection", {});
          return { content: [{ type: "text", text: JSON.stringify(r) }] };
        }
        case "set_properties": {
          const target = pickSession(args, studioSession);
          const r = await enqueueAndWait(target, "set_properties", {
            path: args?.["path"],
            properties: args?.["properties"] ?? {},
          });
          return { content: [{ type: "text", text: JSON.stringify(r) }] };
        }
        case "get_output_logs": {
          const target = pickSession(args, studioSession);
          const r = await enqueueAndWait(target, "get_output_logs", {
            max: args?.["max"] ?? 100,
            filter: args?.["filter"] ?? "all",
          });
          return { content: [{ type: "text", text: JSON.stringify(r) }] };
        }
        case "get_children_of_class": {
          const target = pickSession(args, studioSession);
          const r = await enqueueAndWait(target, "get_children_of_class", {
            path: (args?.["path"] as string) ?? "Workspace",
            class: args?.["class"],
          });
          return { content: [{ type: "text", text: JSON.stringify(r) }] };
        }
        case "list_sessions": {
          // Server-side: não passa pela fila, lê presença direto do Redis.
          const sessions = await listPresence();
          return { content: [{ type: "text", text: JSON.stringify({ sessions }) }] };
        }
        default:
          throw new Error(`Tool desconhecida: ${name}`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { content: [{ type: "text", text: `ERRO: ${msg}` }], isError: true };
    }
  });

  return server;
}

// GET /mcp/sse (auth via Bearer) + POST /mcp/messages (auth + vinculo com a sessao dona)
export function setupMcpRoutes(app: Express, msgLimiter: RequestHandler) {
  const transports = new Map<string, SSEServerTransport>();
  // Transportes em memoria: rode UMA instancia (escala vertical, nao horizontal).
  // Num segundo processo, o POST cai noutro mapa e responde 404 sempre.
  if (!process.env.SINGLE_INSTANCE_OK) {
    console.warn("[rblx-mcp] SSE em memoria - use 1 instancia (sem autoscale/replicas)");
  }

  app.get("/mcp/sse", requireAuth, async (req: AuthedRequest, res) => {
    const studioSession = req.sessionId ?? "";
    // Servidor MCP por conexao: o fallback ja e a sessao autenticada,
    // mesmo que o SDK nao informe extra.sessionId nos handlers.
    const server = createMcpServer(studioSession);
    const transport = new SSEServerTransport("/mcp/messages", res);
    transports.set(transport.sessionId, transport);
    studioByTransport.set(transport.sessionId, studioSession);
    res.on("close", () => {
      transports.delete(transport.sessionId);
      studioByTransport.delete(transport.sessionId);
    });
    await server.connect(transport);
  });

  app.post("/mcp/messages", requireAuth, msgLimiter, async (req: AuthedRequest, res) => {
    const sessionId = String(req.query.sessionId ?? "");
    const transport = transports.get(sessionId);
    if (!transport) {
      res.status(404).json({ error: "Sessão MCP não encontrada (reconecte o SSE; sem replicas: 1 instancia)" });
      return;
    }
    const owner = studioByTransport.get(sessionId);
    if (owner && owner !== req.sessionId) {
      res.status(403).json({ error: "Transporte MCP pertence a outra sessão" });
      return;
    }
    await transport.handlePostMessage(req, res);
  });
}
