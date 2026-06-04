import { execFile } from "node:child_process";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { RequestStore } from "../store/request-store.js";
import type { CapturedFlow, CapturedRequest, CapturedResponse } from "./types.js";

const DEFAULT_CLI_PATH = "/Applications/Proxyman.app/Contents/MacOS/proxyman-cli";
const DEFAULT_POLL_INTERVAL_MS = 2000;

export interface ProxymanCaptureOptions {
  cliPath?: string;
  pollInterval?: number;
  domains?: string[];
  ignoreUrls?: string[];
}

/**
 * Captures network traffic by polling Proxyman's CLI export.
 * Uses `--since <flowId>` for incremental ingestion.
 */
const MAX_EMPTY_POLLS = 5;

export class ProxymanCapture {
  private lastSeenId = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private emptyPollCount = 0;
  private cliPath: string;
  private pollInterval: number;
  private domains: string[];
  private ignorePatterns: RegExp[];

  constructor(
    private store: RequestStore,
    options: ProxymanCaptureOptions = {},
  ) {
    this.cliPath = options.cliPath ?? DEFAULT_CLI_PATH;
    this.pollInterval = options.pollInterval ?? DEFAULT_POLL_INTERVAL_MS;
    this.domains = options.domains ?? [];
    this.ignorePatterns = (options.ignoreUrls ?? []).map((p) => {
      try {
        return new RegExp(p, "i");
      } catch {
        return new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      }
    });
  }

  async start(): Promise<void> {
    // Do an initial poll to pick up existing requests
    await this.poll();
    this.startPolling();
  }

  stop(): void {
    this.stopPolling();
  }

  /**
   * One-shot refresh — called from MCP tool handlers to ensure fresh data.
   * If new data is found, restarts background polling.
   */
  async refresh(): Promise<void> {
    const found = await this.poll();
    if (found > 0 && !this.timer) {
      this.emptyPollCount = 0;
      this.startPolling();
      console.error("[proxyman-capture] New data found, resumed background polling");
    }
  }

  private startPolling(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.poll().then((count) => {
        if (count === 0) {
          this.emptyPollCount++;
          if (this.emptyPollCount >= MAX_EMPTY_POLLS) {
            this.stopPolling();
            console.error("[proxyman-capture] No new data after 5 polls, pausing background polling");
          }
        } else {
          this.emptyPollCount = 0;
        }
      }).catch((err) => {
        console.error(`[proxyman-capture] Poll error: ${err}`);
      });
    }, this.pollInterval);
  }

  private stopPolling(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Returns number of new flows ingested. */
  private async poll(): Promise<number> {
    if (this.polling) return 0;
    this.polling = true;

    const outDir = join(tmpdir(), `proxyman-mcp-${Date.now()}`);

    try {
      await this.exportFlows(outDir);
      const flows = await this.parseExportDir(outDir);

      for (const flow of flows) {
        this.store.add(flow);
      }
      return flows.length;
    } finally {
      this.polling = false;
      // Clean up temp dir
      await rm(outDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private exportFlows(outDir: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = ["export-log", "-o", outDir, "-f", "raw"];

      if (this.domains.length > 0) {
        args.push("-m", "domains");
        for (const d of this.domains) {
          args.push("--domains", d);
        }
      } else {
        args.push("-m", "all");
      }

      if (this.lastSeenId > 0) {
        args.push("--since", String(this.lastSeenId));
      }

      execFile(this.cliPath, args, { timeout: 15_000 }, (err, stdout, stderr) => {
        if (err) {
          // "nothing to export" is not an error — just means no new flows
          const output = (stdout ?? "") + (stderr ?? "");
          if (output.includes("nothing to export") || output.includes("No flows")) {
            resolve();
            return;
          }
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  private async parseExportDir(dir: string): Promise<CapturedFlow[]> {
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      return []; // dir doesn't exist = no new flows
    }

    // Group files by flow ID: "[5109] Request - ..." and "[5109] Response - ..."
    const flowFiles = new Map<number, { request?: string; response?: string }>();

    for (const file of files) {
      const match = file.match(/^\[(\d+)\]\s+(Request|Response)\s+-\s+/);
      if (!match) continue;

      const flowId = parseInt(match[1], 10);
      const type = match[2].toLowerCase() as "request" | "response";

      if (!flowFiles.has(flowId)) {
        flowFiles.set(flowId, {});
      }
      flowFiles.get(flowId)![type] = join(dir, file);
    }

    // Sort by flow ID ascending
    const sortedIds = [...flowFiles.keys()].sort((a, b) => a - b);

    const flows: CapturedFlow[] = [];
    for (const flowId of sortedIds) {
      const entry = flowFiles.get(flowId)!;
      if (!entry.request) continue;

      const flow = await this.parseFlow(flowId, entry.request, entry.response);
      if (flowId > this.lastSeenId) {
        this.lastSeenId = flowId;
      }
      if (!flow) continue;
      if (this.shouldIgnore(flow.request.url)) continue;
      flows.push(flow);
    }

    return flows;
  }

  private async parseFlow(
    _flowId: number,
    requestPath: string,
    responsePath?: string,
  ): Promise<CapturedFlow | null> {
    try {
      const reqRaw = await readFile(requestPath, "utf-8");
      const request = this.parseRequest(reqRaw);
      if (!request) return null;

      const flow: CapturedFlow = {
        id: 0, // assigned by store
        request,
        timing: { startTime: Date.now() },
      };

      if (responsePath) {
        const respRaw = await readFile(responsePath, "utf-8");
        flow.response = this.parseResponse(respRaw);
      }

      return flow;
    } catch {
      return null;
    }
  }

  private shouldIgnore(url: string): boolean {
    for (const pattern of this.ignorePatterns) {
      if (pattern.test(url)) return true;
    }
    return false;
  }

  private parseRequest(raw: string): CapturedRequest | null {
    const headerEnd = raw.indexOf("\r\n\r\n");
    const splitIdx = headerEnd !== -1 ? headerEnd : raw.indexOf("\n\n");
    const headerSection = splitIdx !== -1 ? raw.slice(0, splitIdx) : raw;
    const body = splitIdx !== -1 ? raw.slice(splitIdx + (headerEnd !== -1 ? 4 : 2)) : undefined;

    const lines = headerSection.split(/\r?\n/);
    if (lines.length === 0) return null;

    // First line: "GET /path HTTP/1.1"
    const requestLine = lines[0];
    const match = requestLine.match(/^(\S+)\s+(\S+)/);
    if (!match) return null;

    const method = match[1];
    const path = match[2];

    const headers: Record<string, string> = {};
    let host = "";
    for (let i = 1; i < lines.length; i++) {
      const colonIdx = lines[i].indexOf(":");
      if (colonIdx === -1) continue;
      const key = lines[i].slice(0, colonIdx).trim();
      const value = lines[i].slice(colonIdx + 1).trim();
      headers[key.toLowerCase()] = value;
      if (key.toLowerCase() === "host") {
        host = value;
      }
    }

    const url = host ? `https://${host}${path}` : path;

    return {
      url,
      method,
      headers,
      body: body?.trim() || undefined,
      timestamp: Date.now() / 1000,
    };
  }

  private parseResponse(raw: string): CapturedResponse {
    const headerEnd = raw.indexOf("\r\n\r\n");
    const splitIdx = headerEnd !== -1 ? headerEnd : raw.indexOf("\n\n");
    const headerSection = splitIdx !== -1 ? raw.slice(0, splitIdx) : raw;
    const body = splitIdx !== -1 ? raw.slice(splitIdx + (headerEnd !== -1 ? 4 : 2)).trim() : "";

    const lines = headerSection.split(/\r?\n/);

    // First line: "HTTP/1.1 200 OK"
    let status = 0;
    let statusText = "";
    const statusMatch = lines[0]?.match(/^HTTP\/[\d.]+\s+(\d+)\s*(.*)/);
    if (statusMatch) {
      status = parseInt(statusMatch[1], 10);
      statusText = statusMatch[2] ?? "";
    }

    const headers: Record<string, string> = {};
    let mimeType = "";
    for (let i = 1; i < lines.length; i++) {
      const colonIdx = lines[i].indexOf(":");
      if (colonIdx === -1) continue;
      const key = lines[i].slice(0, colonIdx).trim();
      const value = lines[i].slice(colonIdx + 1).trim();
      headers[key.toLowerCase()] = value;
      if (key.toLowerCase() === "content-type") {
        mimeType = value.split(";")[0].trim();
      }
    }

    return {
      status,
      statusText,
      headers,
      mimeType,
      body: body || undefined,
      bodySize: body.length,
      encodedDataLength: body.length,
    };
  }
}
