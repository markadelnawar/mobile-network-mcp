import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { homedir } from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { startCdpSource, type CdpSourceHandle } from "./capture/cdp-source.js";
import { IngestServer } from "./capture/ingest-server.js";
import { ProxymanCapture } from "./capture/proxyman-capture.js";
import { RequestStore } from "./store/request-store.js";
import { listRequests, listRequestsSchema } from "./tools/list-requests.js";
import { getResponseSchema, getResponseSchemaInputSchema } from "./tools/get-response-schema.js";
import { queryResponse, queryResponseSchema } from "./tools/query-response.js";
import { getResponseRaw, getResponseRawSchema } from "./tools/get-response-raw.js";

/**
 * `auto` (default): the ingest server always runs, and the server keeps trying
 * to attach to Metro's inspector; on React Native 0.83+ that makes CDP the
 * capture door with nothing added to the app, older runtimes fall back to
 * ingest. `cdp` is the same path made explicit; `ingest` skips the Metro
 * attempt; `proxyman` polls proxyman-cli instead.
 */
export type CaptureSource = "auto" | "proxyman" | "cdp" | "ingest";
export const CAPTURE_SOURCES: readonly CaptureSource[] = ["auto", "proxyman", "cdp", "ingest"];

export interface ServerConfig {
  metroPort: number;
  metroHost: string;
  maxFlows: number;
  source?: CaptureSource;
  domains?: string[];
  proxymanCliPath?: string;
  pollInterval?: number;
  ignoreUrls?: string[];
  ingestPort?: number;
}

export async function createServer(config: ServerConfig): Promise<McpServer> {
  const store = new RequestStore(config.maxFlows);
  const source = config.source ?? "auto";
  let ingestPort = config.ingestPort ?? 7890;
  let cdpSource: CdpSourceHandle | null = null;

  const describeSource = (): string => {
    if (source === "proxyman") return "proxyman (polling proxyman-cli)";
    if (source === "ingest") return "ingest (flows are pushed by interceptor.js or the Proxyman script)";
    const s = cdpSource?.status();
    const where = `Metro ${config.metroHost}:${config.metroPort}`;
    switch (s?.state) {
      case "connected":
        return `${source} → CDP connected to ${where}`;
      case "reconnecting":
        return `${source} → CDP reconnecting to ${where}; flows still arrive via the ingest server`;
      case "unsupported":
        return `${source} → ingest only; CDP unavailable: ${s.detail}`;
      default:
        return `${source} → waiting for a React Native app on ${where} (${s?.attempts ?? 0} attempt(s)${s?.detail ? `, last: ${s.detail}` : ""}); flows still arrive via the ingest server`;
    }
  };

  // Optional refresh hook — called before each tool invocation (used by Proxyman CLI capture)
  let onBeforeToolCall: (() => Promise<void>) | null = null;

  const server = new McpServer(
    {
      name: "mobile-network-mcp",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  // --- Tools ---

  server.registerTool("list_requests", {
    title: "List Network Requests",
    description:
      "List captured network requests from the mobile app. Returns a compact table with ID, method, status, URL, size, and timing. Use filters to narrow results.",
    inputSchema: listRequestsSchema,
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  }, async (input) => {
    await onBeforeToolCall?.();
    return { content: [{ type: "text", text: listRequests(store, input) }] };
  });

  server.registerTool("get_response_schema", {
    title: "Get Response Schema",
    description:
      "Get the JSON schema/structure of a response WITHOUT the actual values. Shows keys and their types in a compact format. Use this to understand the shape of an API response before querying specific fields — saves tokens vs reading the full response.",
    inputSchema: getResponseSchemaInputSchema,
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  }, async (input) => {
    await onBeforeToolCall?.();
    return { content: [{ type: "text", text: getResponseSchema(store, input) }] };
  });

  server.registerTool("query_response", {
    title: "Query Response",
    description:
      'Extract specific values from a JSON response by path. Supports dot notation (data.users), array indexing (data.users[0]), and wildcards (data.users[*].id). Use "paths" to query multiple paths in one call. Use after get_response_schema to fetch only the fields you need.',
    inputSchema: queryResponseSchema,
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  }, async (input) => {
    await onBeforeToolCall?.();
    return { content: [{ type: "text", text: queryResponse(store, input) }] };
  });

  server.registerTool("get_response_raw", {
    title: "Get Raw Response",
    description:
      "Get the full raw response body. Use this as an escape hatch when you need the complete response. Prefer get_response_schema + query_response for token efficiency.",
    inputSchema: getResponseRawSchema,
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  }, async (input) => {
    await onBeforeToolCall?.();
    return { content: [{ type: "text", text: getResponseRaw(store, input) }] };
  });

  server.registerTool("server_status", {
    title: "Server Status",
    description:
      "Report the ingest server's port and the number of captured flows. Use this to discover which port app interceptors should POST to.",
    inputSchema: z.object({}),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  }, async () => {
    await onBeforeToolCall?.();
    const text =
      `Ingest server: http://localhost:${ingestPort}/flows\n` +
      `Captured flows: ${store.size}\n` +
      `Capture source: ${describeSource()}`;
    return { content: [{ type: "text", text }] };
  });

  // --- Ingest server (always runs — accepts flows from any external interceptor) ---

  const ingest = new IngestServer(store, {
    port: config.ingestPort,
    ignoreUrls: config.ignoreUrls,
  });
  ingest.start().then(async (port) => {
    ingestPort = port;
    console.error(`[mobile-network-mcp] Ingest server listening on http://localhost:${port}/flows`);
    await writePortFile(port).catch(() => {});
  }).catch((err) => {
    console.error(`[mobile-network-mcp] Ingest server failed to start: ${err}`);
  });

  // --- Start capture source ---

  if (source === "proxyman") {
    const capture = new ProxymanCapture(store, {
      cliPath: config.proxymanCliPath,
      pollInterval: config.pollInterval,
      domains: config.domains,
      ignoreUrls: config.ignoreUrls,
    });
    onBeforeToolCall = () => capture.refresh();
    capture.start().then(() => {
      console.error("[mobile-network-mcp] Proxyman capture started");
    }).catch((err) => {
      console.error(`[mobile-network-mcp] Proxyman capture failed to start: ${err}`);
    });
  } else if (source === "cdp" || source === "auto") {
    cdpSource = startCdpSource({
      store,
      metroHost: config.metroHost,
      metroPort: config.metroPort,
      ignoreUrls: config.ignoreUrls,
    });
  }
  // source === "ingest" — ingest server only, no active capture

  return server;
}

/** Start the MCP server with stdio transport. */
export async function startServer(config: ServerConfig): Promise<void> {
  const server = await createServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mobile-network-mcp] MCP server started on stdio");
}

/** Write the resolved ingest port to a fixed file so host-side clients can discover it. */
async function writePortFile(port: number): Promise<void> {
  const dir = join(homedir(), ".mobile-network-mcp");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "port"), String(port), "utf-8");
}