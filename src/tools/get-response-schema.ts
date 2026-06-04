import { z } from "zod";
import type { RequestStore } from "../store/request-store.js";
import { inferSchema, renderSchema } from "json-schema-sketch";

export const getResponseSchemaInputSchema = z.object({
  request_id: z.number().describe("Request ID from list_requests"),
  max_depth: z.number().min(1).max(20).optional().describe("Max nesting depth (default 6). Increase if the schema shows opaque '{}' objects you need to see inside."),
  show_string_lengths: z.boolean().optional().describe("Show character lengths for strings, e.g. string(21). Default: false."),
});

export type GetResponseSchemaInput = z.infer<typeof getResponseSchemaInputSchema>;

export function getResponseSchema(store: RequestStore, input: GetResponseSchemaInput): string {
  const flow = store.get(input.request_id);
  if (!flow) {
    return `Request #${input.request_id} not found. Use list_requests to see available requests.`;
  }

  const header = `Request #${flow.id}: ${flow.request.method} ${shortenUrl(flow.request.url)}`;
  const statusInfo = flow.response
    ? ` (${flow.response.status}, ${formatSize(flow.response.bodySize)})`
    : " (pending)";

  if (!flow.response?.body) {
    return `${header}${statusInfo}\n\nNo response body available.`;
  }

  const parsed = store.getParsedJson(flow);
  if (!parsed.ok) {
    // Non-JSON response — show basic info
    const mimeType = flow.response.mimeType || "unknown";
    return `${header}${statusInfo}\n\nResponse is ${mimeType}, not JSON. Use get_response_raw to see the body.`;
  }

  const maxDepth = input.max_depth ?? 6;
  const schema = inferSchema(parsed.value, 0, maxDepth);
  const rendered = renderSchema(schema, { showStringLengths: input.show_string_lengths ?? false });

  return `${header}${statusInfo}\n\nResponse schema:\n${rendered}`;
}

function shortenUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname + parsed.search;
  } catch {
    return url;
  }
}

function formatSize(bytes: number): string {
  if (bytes === 0) return "0B";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
