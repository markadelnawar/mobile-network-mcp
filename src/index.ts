import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { CDPClient } from "./capture/cdp-client.js";
import { IngestServer } from "./capture/ingest-server.js";
import { NetworkCapture } from "./capture/network-capture.js";
import { ProxymanCapture } from "./capture/proxyman-capture.js";
import { RequestStore } from "./store/request-store.js";
import { listRequests, listRequestsSchema } from "./tools/list-requests.js";
import { getResponseSchema, getResponseSchemaInputSchema } from "./tools/get-response-schema.js";
import { queryResponse, queryResponseSchema } from "./tools/query-response.js";
import { getResponseRaw, getResponseRawSchema } from "./tools/get-response-raw.js";

export type CaptureSource = "proxyman" | "cdp" | "ingest";

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
  const source = config.source ?? "ingest";

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

  // --- Ingest server (always runs — accepts flows from any external interceptor) ---

  const ingest = new IngestServer(store, {
    port: config.ingestPort,
    ignoreUrls: config.ignoreUrls,
  });
  ingest.start().then((port) => {
    console.error(`[mobile-network-mcp] Ingest server listening on http://localhost:${port}/flows`);
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
  } else if (source === "cdp") {
    const cdp = new CDPClient(config.metroPort, config.metroHost);
    const capture = new NetworkCapture(cdp, store);
    connectWithRetry(cdp, capture, config).catch(() => {
      // Connection retries are handled internally
    });
  }
  // source === "ingest" — ingest server only, no active capture

  return server;
}

async function connectWithRetry(
  cdp: CDPClient,
  capture: NetworkCapture,
  config: ServerConfig,
  maxRetries: number = 5,
): Promise<void> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await cdp.connect();
      await capture.start();
      console.error(
        `[mobile-network-mcp] Connected to Metro on ${config.metroHost}:${config.metroPort}`,
      );
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[mobile-network-mcp] Connection attempt ${attempt}/${maxRetries} failed: ${message}`,
      );
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }
  console.error(
    `[mobile-network-mcp] Could not connect to Metro after ${maxRetries} attempts. ` +
      `The server is running — requests will be captured once Metro is available.`,
  );
}

/** Start the MCP server with stdio transport. */
export async function startServer(config: ServerConfig): Promise<void> {
  const server = await createServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mobile-network-mcp] MCP server started on stdio");
}
