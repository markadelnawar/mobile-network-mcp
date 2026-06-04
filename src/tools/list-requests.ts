import { z } from "zod";
import type { RequestStore } from "../store/request-store.js";

export const listRequestsSchema = z.object({
  url_pattern: z.string().optional().describe("Filter by URL (substring or regex)"),
  method: z.string().optional().describe("Filter by HTTP method (GET, POST, etc.)"),
  status_min: z.number().optional().describe("Minimum status code (e.g., 400 for errors)"),
  status_max: z.number().optional().describe("Maximum status code"),
  limit: z.number().min(1).max(100).optional().describe("Max results (default 20)"),
  offset: z.number().min(0).optional().describe("Pagination offset"),
});

export type ListRequestsInput = z.infer<typeof listRequestsSchema>;

export function listRequests(store: RequestStore, input: ListRequestsInput): string {
  const { flows, total } = store.list({
    urlPattern: input.url_pattern,
    method: input.method,
    statusMin: input.status_min,
    statusMax: input.status_max,
    limit: input.limit,
    offset: input.offset,
  });

  if (flows.length === 0) {
    if (total === 0 && store.size === 0) {
      return "No requests captured yet. Make some API calls in your React Native app.";
    }
    return `No requests match your filters. ${store.size} total request(s) captured.`;
  }

  const lines: string[] = [];
  lines.push("ID  | Method | Status | URL                                        | Size    | Time");
  lines.push("----+--------+--------+--------------------------------------------+---------+-------");

  for (const flow of flows) {
    const id = String(flow.id).padStart(3);
    const method = flow.request.method.padEnd(6);
    const status = flow.response
      ? String(flow.response.status).padEnd(6)
      : "...   ";
    const url = truncateUrl(flow.request.url, 42);
    const size = flow.response
      ? formatSize(flow.response.bodySize || flow.response.encodedDataLength).padStart(7)
      : "    -  ";
    const time = flow.timing.duration !== undefined
      ? `${flow.timing.duration}ms`.padStart(6)
      : "   -  ";

    lines.push(`${id} | ${method} | ${status} | ${url} | ${size} | ${time}`);
  }

  const showing = flows.length;
  const offset = input.offset ?? 0;
  if (total > showing) {
    lines.push(`\n[Showing ${offset + 1}-${offset + showing} of ${total} matching requests]`);
  } else {
    lines.push(`\n[${total} request(s)]`);
  }

  return lines.join("\n");
}

function truncateUrl(url: string, maxLen: number): string {
  // Strip origin for cleaner display
  try {
    const parsed = new URL(url);
    const path = parsed.pathname + parsed.search;
    if (path.length <= maxLen) return path.padEnd(maxLen);
    return (path.slice(0, maxLen - 3) + "...").padEnd(maxLen);
  } catch {
    if (url.length <= maxLen) return url.padEnd(maxLen);
    return (url.slice(0, maxLen - 3) + "...").padEnd(maxLen);
  }
}

function formatSize(bytes: number): string {
  if (bytes === 0) return "-";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
