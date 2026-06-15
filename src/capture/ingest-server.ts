import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { RequestStore } from "../store/request-store.js";
import type { CapturedFlow } from "./types.js";

const DEFAULT_PORT = 7890;

export interface IngestServerOptions {
  port?: number;
  ignoreUrls?: string[];
}

/**
 * Lightweight HTTP server that accepts POST /flows to ingest network traffic.
 * Any interceptor (RN, Flutter, native, custom) can push flows into the store.
 */
export class IngestServer {
  private server: ReturnType<typeof createServer> | null = null;
  private port: number;
  private ignorePatterns: RegExp[];

  constructor(
    private store: RequestStore,
    options: IngestServerOptions = {},
  ) {
    this.port = options.port ?? DEFAULT_PORT;
    this.ignorePatterns = (options.ignoreUrls ?? []).map((p) => {
      try {
        return new RegExp(p, "i");
      } catch {
        return new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      }
    });
  }

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => this.handleRequest(req, res));

      this.server.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          // Try next port
          this.port++;
          this.server!.listen(this.port);
        } else {
          reject(err);
        }
      });

      this.server.on("listening", () => {
        resolve(this.port);
      });

      this.server.listen(this.port);
    });
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    // CORS headers for dev environments
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "POST" && req.url === "/flows") {
      this.handleIngest(req, res);
      return;
    }

    if (req.method === "POST" && req.url === "/flows/batch") {
      this.handleBatchIngest(req, res);
      return;
    }

    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", flows: this.store.size }));
      return;
    }

    res.writeHead(404);
    res.end();
  }

  private handleIngest(req: IncomingMessage, res: ServerResponse): void {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const data = JSON.parse(body);
        const flow = this.toFlow(data);
        if (!flow) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid flow: request.url and request.method are required" }));
          return;
        }
        if (this.shouldIgnore(flow.request.url)) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ignored: true }));
          return;
        }
        const added = this.store.add(flow);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: added.id }));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
    });
  }

  private handleBatchIngest(req: IncomingMessage, res: ServerResponse): void {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const items = JSON.parse(body);
        if (!Array.isArray(items)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Expected an array" }));
          return;
        }
        const ids: number[] = [];
        for (const item of items) {
          const flow = this.toFlow(item);
          if (!flow) continue;
          if (this.shouldIgnore(flow.request.url)) continue;
          const added = this.store.add(flow);
          ids.push(added.id);
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ids }));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
    });
  }

  /**
   * Coerce a body value to a string. Objects/arrays (e.g. JSON already parsed by an
   * upstream interceptor) are re-serialized as JSON rather than passed through
   * String(), which would mangle them into "[object Object]" or comma-joined text.
   */
  private bodyToString(body: unknown): string | undefined {
    if (body == null) return undefined;
    if (typeof body === "string") return body;
    try {
      return JSON.stringify(body);
    } catch {
      return String(body);
    }
  }

  private toFlow(data: Record<string, unknown>): CapturedFlow | null {
    const req = data.request as Record<string, unknown> | undefined;
    if (!req?.url || !req?.method) return null;

    const resp = data.response as Record<string, unknown> | undefined;
    const respHeaders = (resp?.headers as Record<string, string>) ?? {};
    const contentType = respHeaders["content-type"] ?? respHeaders["Content-Type"] ?? "";
    const respBody = this.bodyToString(resp?.body);

    const flow: CapturedFlow = {
      id: 0,
      request: {
        url: String(req.url),
        method: String(req.method),
        headers: (req.headers as Record<string, string>) ?? {},
        body: this.bodyToString(req.body),
        timestamp: (data.timestamp as number) ?? Date.now() / 1000,
      },
      timing: {
        startTime: (data.startTime as number) ?? Date.now(),
        endTime: (data.endTime as number) ?? Date.now(),
        duration: (data.duration as number) ?? 0,
      },
    };

    if (resp) {
      flow.response = {
        status: (resp.status as number) ?? 0,
        statusText: (resp.statusText as string) ?? "",
        headers: respHeaders,
        mimeType: contentType.split(";")[0].trim(),
        body: respBody,
        bodySize: respBody?.length ?? 0,
        encodedDataLength: respBody?.length ?? 0,
      };
    }

    return flow;
  }

  private shouldIgnore(url: string): boolean {
    for (const pattern of this.ignorePatterns) {
      if (pattern.test(url)) return true;
    }
    return false;
  }
}
