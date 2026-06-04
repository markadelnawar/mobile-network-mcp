import { z } from "zod";
import type { RequestStore } from "../store/request-store.js";

export const getResponseRawSchema = z.object({
  request_id: z.number().describe("Request ID from list_requests"),
  truncate_at: z
    .number()
    .min(100)
    .optional()
    .describe("Max bytes to return (default 8192)"),
});

export type GetResponseRawInput = z.infer<typeof getResponseRawSchema>;

export function getResponseRaw(store: RequestStore, input: GetResponseRawInput): string {
  const flow = store.get(input.request_id);
  if (!flow) {
    return `Request #${input.request_id} not found. Use list_requests to see available requests.`;
  }

  const header = `Request #${flow.id}: ${flow.request.method} ${shortenUrl(flow.request.url)}`;

  if (!flow.response) {
    return `${header}\n\nNo response received yet.`;
  }

  const statusLine = `${flow.response.status} ${flow.response.statusText}`.trim();
  const mimeType = flow.response.mimeType || "unknown";

  if (!flow.response.body) {
    return `${header} — ${statusLine}\nContent-Type: ${mimeType}\n\nNo response body available.`;
  }

  const maxBytes = input.truncate_at ?? 8192;
  let body = flow.response.body;
  let truncated = false;

  if (body.length > maxBytes) {
    body = body.slice(0, maxBytes);
    truncated = true;
  }

  let output = `${header} — ${statusLine}\nContent-Type: ${mimeType}\nBody size: ${flow.response.bodySize}B\n\n${body}`;

  if (truncated) {
    output += `\n\n... [truncated at ${maxBytes} bytes, total ${flow.response.bodySize}B]`;
  }

  return output;
}

function shortenUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname + parsed.search;
  } catch {
    return url;
  }
}
