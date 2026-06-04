import { z } from "zod";
import type { RequestStore } from "../store/request-store.js";
import { resolvePath } from "json-schema-sketch";

export const queryResponseSchema = z.object({
  request_id: z.number().describe("Request ID from list_requests"),
  path: z
    .string()
    .optional()
    .describe('Single JSON path (e.g., "data.users[0].name"). Use "paths" to query multiple at once.'),
  paths: z
    .array(z.string())
    .optional()
    .describe('Multiple JSON paths in one call (e.g., ["hits[*].name", "hits[*].price", "search.q"])'),
  max_items: z
    .number()
    .min(1)
    .max(100)
    .optional()
    .describe("For wildcards: max items to return (default 5)"),
});

export type QueryResponseInput = z.infer<typeof queryResponseSchema>;

export function queryResponse(store: RequestStore, input: QueryResponseInput): string {
  const flow = store.get(input.request_id);
  if (!flow) {
    return `Request #${input.request_id} not found. Use list_requests to see available requests.`;
  }

  if (!flow.response?.body) {
    return `Request #${flow.id}: No response body available.`;
  }

  const parsed = store.getParsedJson(flow);
  if (!parsed.ok) {
    return `Request #${flow.id}: ${parsed.error}`;
  }

  const allPaths: string[] = [];
  if (input.paths) allPaths.push(...input.paths);
  if (input.path) allPaths.push(input.path);

  if (allPaths.length === 0) {
    return `Request #${flow.id}: Provide "path" or "paths" parameter.`;
  }

  const maxItems = input.max_items ?? 5;
  const header = `Request #${flow.id}: ${flow.request.method} ${shortenUrl(flow.request.url)}`;

  // Single path — detailed output
  if (allPaths.length === 1) {
    return formatSingleResult(parsed.value, allPaths[0], maxItems, header);
  }

  // Multi-path — compact output
  const sections: string[] = [];
  for (const p of allPaths) {
    const result = resolvePath(parsed.value, p, maxItems);
    if (!result.ok) {
      sections.push(`${p}: ERROR — ${result.error}`);
      continue;
    }
    if (result.isWildcard) {
      const showing = (result.value as unknown[]).length;
      const total = result.totalItems ?? showing;
      sections.push(`${p} (${showing}/${total}): ${formatValue(result.value)}`);
    } else {
      sections.push(`${p}: ${formatValue(result.value)}`);
    }
  }

  return `${header}\n\n${sections.join("\n\n")}`;
}

function formatSingleResult(root: unknown, path: string, maxItems: number, header: string): string {
  const result = resolvePath(root, path, maxItems);

  if (!result.ok) {
    return `${header} -> ${path}\n\nError: ${result.error}`;
  }

  if (result.isWildcard) {
    const showing = (result.value as unknown[]).length;
    const total = result.totalItems ?? showing;
    const valueStr = formatValue(result.value);
    let output = `${header} -> ${path}\n\nValues (showing ${showing} of ${total}):\n${valueStr}`;
    if (total > showing) {
      output += `\n\n[Use max_items to see more]`;
    }
    return output;
  }

  const valueStr = formatValue(result.value);
  const typeInfo = describeType(result.value);
  return `${header} -> ${path}\n\nValue: ${valueStr}\nType: ${typeInfo}`;
}

function formatValue(value: unknown): string {
  const str = JSON.stringify(value, null, 2);
  // Truncate very large values
  if (str.length > 4096) {
    return str.slice(0, 4096) + "\n... [truncated]";
  }
  return str;
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === "string") return `string(${value.length} chars)`;
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "float";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "object") return `object(${Object.keys(value).length} keys)`;
  return typeof value;
}

function shortenUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname + parsed.search;
  } catch {
    return url;
  }
}
