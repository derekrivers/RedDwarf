import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import {
  pipelineRunStatusSchema,
  taskLifecycleStatusSchema,
  taskPhaseSchema
} from "@reddwarf/contracts";

const MAX_MCP_QUERY_LIMIT = 100;

const positiveLimitSchema = z.number().int().positive().max(MAX_MCP_QUERY_LIMIT);

const findTaskHistoryArgsSchema = z.object({
  repo: z.string().min(1).optional(),
  query: z.string().min(1).optional(),
  lifecycleStatuses: z.array(taskLifecycleStatusSchema).default([]),
  phases: z.array(taskPhaseSchema).default([]),
  limit: positiveLimitSchema.default(10)
});

const getTaskHistoryArgsSchema = z.object({
  taskId: z.string().min(1)
});

const getTaskEvidenceArgsSchema = z.object({
  taskId: z.string().min(1)
});

const listRunsArgsSchema = z.object({
  repo: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  statuses: z.array(pipelineRunStatusSchema).default([]),
  limit: positiveLimitSchema.default(10)
});

const getRunArgsSchema = z.object({
  runId: z.string().min(1)
});

const getRunEvidenceArgsSchema = z.object({
  runId: z.string().min(1)
});

type OperatorMcpToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

const operatorMcpToolDefinitions: readonly OperatorMcpToolDefinition[] = [
  {
    name: "reddwarf_find_task_history",
    description:
      "Search RedDwarf task history across current and prior tasks, optionally filtered by repo, lifecycle status, and phase.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        repo: { type: "string" },
        query: { type: "string" },
        lifecycleStatuses: {
          type: "array",
          items: { type: "string" }
        },
        phases: {
          type: "array",
          items: { type: "string" }
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_MCP_QUERY_LIMIT
        }
      }
    }
  },
  {
    name: "reddwarf_get_task_history",
    description:
      "Get full RedDwarf task history for one task, including manifest, runs, approvals, memory, and run summaries.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["taskId"],
      properties: {
        taskId: { type: "string" }
      }
    }
  },
  {
    name: "reddwarf_get_task_evidence",
    description: "Get all evidence records attached to a RedDwarf task.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["taskId"],
      properties: {
        taskId: { type: "string" }
      }
    }
  },
  {
    name: "reddwarf_list_runs",
    description:
      "List RedDwarf pipeline runs, optionally filtered by repo, task id, and run status.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        repo: { type: "string" },
        taskId: { type: "string" },
        statuses: {
          type: "array",
          items: { type: "string" }
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_MCP_QUERY_LIMIT
        }
      }
    }
  },
  {
    name: "reddwarf_get_run",
    description:
      "Get one RedDwarf pipeline run with summary, phase events, and token usage.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["runId"],
      properties: {
        runId: { type: "string" }
      }
    }
  },
  {
    name: "reddwarf_get_run_evidence",
    description: "Get evidence records associated with one RedDwarf pipeline run.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["runId"],
      properties: {
        runId: { type: "string" }
      }
    }
  }
] as const;

const supportedProtocolVersions = new Set(["2024-11-05", "2025-03-26"]);

type JsonRpcId = string | number | null;

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
};

type OperatorMcpBridgeOptions = {
  baseUrl?: string;
  operatorToken?: string;
  fetchImpl?: typeof fetch;
};

function resolveBaseUrl(baseUrl?: string): string {
  const resolved =
    baseUrl?.trim() ||
    process.env.REDDWARF_API_URL?.trim() ||
    "http://127.0.0.1:8080";
  return resolved.replace(/\/+$/, "");
}

function resolveOperatorToken(operatorToken?: string): string {
  const resolved = operatorToken?.trim() || process.env.REDDWARF_OPERATOR_TOKEN?.trim() || "";
  if (!resolved) {
    throw new Error("REDDWARF_OPERATOR_TOKEN is required for the RedDwarf MCP bridge.");
  }
  return resolved;
}

function buildQueryString(params: Record<string, string | number | readonly string[] | undefined>): string {
  const searchParams = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        searchParams.append(key, item);
      }
      continue;
    }

    searchParams.set(key, String(value));
  }

  const query = searchParams.toString();
  return query ? `?${query}` : "";
}

function formatToolResult(name: string, payload: unknown): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: unknown;
} {
  return {
    content: [
      {
        type: "text",
        text: `${name}\n${JSON.stringify(payload, null, 2)}`
      }
    ],
    structuredContent: payload
  };
}

function formatToolError(message: string): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  return {
    content: [
      {
        type: "text",
        text: message
      }
    ],
    isError: true
  };
}

function filterTaskHistoryByQuery(
  tasks: Array<Record<string, unknown>>,
  query: string | undefined
): Array<Record<string, unknown>> {
  if (!query) {
    return tasks;
  }

  const normalized = query.trim().toLowerCase();
  return tasks.filter((task) => {
    const manifest =
      task["manifest"] && typeof task["manifest"] === "object"
        ? (task["manifest"] as Record<string, unknown>)
        : {};
    const latestRun =
      task["latestRun"] && typeof task["latestRun"] === "object"
        ? (task["latestRun"] as Record<string, unknown>)
        : {};
    const haystack = [
      manifest["taskId"],
      manifest["title"],
      manifest["summary"],
      manifest["currentPhase"],
      manifest["lifecycleStatus"],
      latestRun["runId"],
      latestRun["status"]
    ]
      .filter((value): value is string => typeof value === "string")
      .join("\n")
      .toLowerCase();

    return haystack.includes(normalized);
  });
}

async function fetchOperatorJson(
  baseUrl: string,
  operatorToken: string,
  path: string,
  fetchImpl: typeof fetch
): Promise<unknown> {
  const response = await fetchImpl(`${baseUrl}${path}`, {
    headers: {
      Authorization: `Bearer ${operatorToken}`,
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Operator API ${path} returned ${response.status}${body ? `: ${body}` : ""}`
    );
  }

  return await response.json();
}

export function createOperatorMcpBridge(options: OperatorMcpBridgeOptions = {}) {
  const baseUrl = resolveBaseUrl(options.baseUrl);
  const operatorToken = resolveOperatorToken(options.operatorToken);
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    listTools() {
      return operatorMcpToolDefinitions;
    },

    async callTool(name: string, args: unknown) {
      switch (name) {
        case "reddwarf_find_task_history": {
          const parsed = findTaskHistoryArgsSchema.parse(args ?? {});
          const response = (await fetchOperatorJson(
            baseUrl,
            operatorToken,
            `/tasks${buildQueryString({
              ...(parsed.repo ? { repo: parsed.repo } : {}),
              ...(parsed.lifecycleStatuses.length > 0
                ? { statuses: parsed.lifecycleStatuses }
                : {}),
              ...(parsed.phases.length > 0 ? { phases: parsed.phases } : {}),
              limit: parsed.limit
            })}`,
            fetchImpl
          )) as {
            tasks?: Array<Record<string, unknown>>;
            total?: number;
          };
          const tasks = Array.isArray(response.tasks) ? response.tasks : [];
          const filteredTasks = filterTaskHistoryByQuery(tasks, parsed.query);

          return formatToolResult(name, {
            repo: parsed.repo ?? null,
            query: parsed.query ?? null,
            total: filteredTasks.length,
            tasks: filteredTasks
          });
        }

        case "reddwarf_get_task_history": {
          const parsed = getTaskHistoryArgsSchema.parse(args ?? {});
          const response = await fetchOperatorJson(
            baseUrl,
            operatorToken,
            `/tasks/${encodeURIComponent(parsed.taskId)}`,
            fetchImpl
          );
          return formatToolResult(name, response);
        }

        case "reddwarf_get_task_evidence": {
          const parsed = getTaskEvidenceArgsSchema.parse(args ?? {});
          const response = await fetchOperatorJson(
            baseUrl,
            operatorToken,
            `/tasks/${encodeURIComponent(parsed.taskId)}/evidence`,
            fetchImpl
          );
          return formatToolResult(name, response);
        }

        case "reddwarf_list_runs": {
          const parsed = listRunsArgsSchema.parse(args ?? {});
          const response = await fetchOperatorJson(
            baseUrl,
            operatorToken,
            `/runs${buildQueryString({
              ...(parsed.repo ? { repo: parsed.repo } : {}),
              ...(parsed.taskId ? { taskId: parsed.taskId } : {}),
              ...(parsed.statuses.length > 0 ? { statuses: parsed.statuses } : {}),
              limit: parsed.limit
            })}`,
            fetchImpl
          );
          return formatToolResult(name, response);
        }

        case "reddwarf_get_run": {
          const parsed = getRunArgsSchema.parse(args ?? {});
          const response = await fetchOperatorJson(
            baseUrl,
            operatorToken,
            `/runs/${encodeURIComponent(parsed.runId)}`,
            fetchImpl
          );
          return formatToolResult(name, response);
        }

        case "reddwarf_get_run_evidence": {
          const parsed = getRunEvidenceArgsSchema.parse(args ?? {});
          const response = await fetchOperatorJson(
            baseUrl,
            operatorToken,
            `/runs/${encodeURIComponent(parsed.runId)}/evidence`,
            fetchImpl
          );
          return formatToolResult(name, response);
        }

        default:
          return formatToolError(`Unknown RedDwarf MCP tool: ${name}`);
      }
    }
  };
}

function writeJsonRpcMessage(message: unknown): void {
  const json = JSON.stringify(message);
  const payload = `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`;
  process.stdout.write(payload);
}

async function readPackageVersion(): Promise<string> {
  try {
    const packageJson = JSON.parse(
      await readFile(resolve(process.cwd(), "package.json"), "utf8")
    ) as { version?: unknown };
    return typeof packageJson.version === "string" && packageJson.version.trim().length > 0
      ? packageJson.version
      : "0.1.0";
  } catch {
    return "0.1.0";
  }
}

async function handleJsonRpcRequest(
  bridge: ReturnType<typeof createOperatorMcpBridge>,
  request: JsonRpcRequest,
  serverVersion: string,
  initialized: { value: boolean }
): Promise<void> {
  const method = typeof request.method === "string" ? request.method : "";
  const id = request.id ?? null;

  const sendResult = (result: unknown) => {
    if (request.id === undefined) {
      return;
    }
    writeJsonRpcMessage({
      jsonrpc: "2.0",
      id,
      result
    });
  };

  const sendError = (code: number, message: string, data?: unknown) => {
    if (request.id === undefined) {
      return;
    }
    writeJsonRpcMessage({
      jsonrpc: "2.0",
      id,
      error: {
        code,
        message,
        ...(data !== undefined ? { data } : {})
      }
    });
  };

  if (method === "initialize") {
    const params =
      request.params && typeof request.params === "object"
        ? (request.params as Record<string, unknown>)
        : {};
    const protocolVersion =
      typeof params["protocolVersion"] === "string" &&
      supportedProtocolVersions.has(params["protocolVersion"])
        ? params["protocolVersion"]
        : "2025-03-26";

    initialized.value = true;
    sendResult({
      protocolVersion,
      capabilities: {
        tools: {
          listChanged: false
        }
      },
      serverInfo: {
        name: "reddwarf-operator-mcp",
        version: serverVersion
      }
    });
    return;
  }

  if (method === "notifications/initialized") {
    initialized.value = true;
    return;
  }

  if (method === "ping") {
    sendResult({});
    return;
  }

  if (!initialized.value) {
    sendError(-32002, "MCP server has not been initialized.");
    return;
  }

  if (method === "tools/list") {
    sendResult({
      tools: bridge.listTools()
    });
    return;
  }

  if (method === "tools/call") {
    const params =
      request.params && typeof request.params === "object"
        ? (request.params as Record<string, unknown>)
        : {};
    const name = typeof params["name"] === "string" ? params["name"] : "";
    const args = params["arguments"];

    try {
      const result = await bridge.callTool(name, args);
      sendResult(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendResult(formatToolError(message));
    }
    return;
  }

  sendError(-32601, `Method not found: ${method}`);
}

export async function runOperatorMcpStdioServer(
  options: OperatorMcpBridgeOptions = {}
): Promise<void> {
  const bridge = createOperatorMcpBridge(options);
  const serverVersion = await readPackageVersion();
  const initialized = { value: false };
  let buffer = Buffer.alloc(0);

  process.stdin.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return;
      }

      const headerText = buffer.slice(0, headerEnd).toString("utf8");
      const contentLengthMatch = /^Content-Length:\s*(\d+)$/im.exec(headerText);
      if (!contentLengthMatch) {
        writeJsonRpcMessage({
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32700,
            message: "Missing Content-Length header."
          }
        });
        buffer = Buffer.alloc(0);
        return;
      }

      const contentLength = Number.parseInt(contentLengthMatch[1] ?? "0", 10);
      const messageStart = headerEnd + 4;
      const messageEnd = messageStart + contentLength;
      if (buffer.length < messageEnd) {
        return;
      }

      const body = buffer.slice(messageStart, messageEnd).toString("utf8");
      buffer = buffer.slice(messageEnd);

      let parsed: JsonRpcRequest | JsonRpcRequest[];
      try {
        parsed = JSON.parse(body) as JsonRpcRequest | JsonRpcRequest[];
      } catch {
        writeJsonRpcMessage({
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32700,
            message: "Invalid JSON payload."
          }
        });
        continue;
      }

      const requests = Array.isArray(parsed) ? parsed : [parsed];
      for (const request of requests) {
        void handleJsonRpcRequest(bridge, request, serverVersion, initialized);
      }
    }
  });

  process.stdin.resume();
}
