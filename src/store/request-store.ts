import type { CapturedFlow } from "../capture/types.js";

export interface FilterOptions {
  urlPattern?: string;
  method?: string;
  statusMin?: number;
  statusMax?: number;
  limit?: number;
  offset?: number;
}

/**
 * Ring-buffer store for captured network flows.
 * Auto-incrementing IDs for easy reference by AI models.
 */
export class RequestStore {
  private flows: CapturedFlow[] = [];
  private nextId = 1;

  constructor(private maxSize: number = 500) {}

  /** Add a flow to the store. Assigns an auto-incrementing ID. */
  add(flow: CapturedFlow): CapturedFlow {
    flow.id = this.nextId++;

    this.flows.push(flow);

    // Evict oldest when over capacity
    if (this.flows.length > this.maxSize) {
      this.flows.shift();
    }

    return flow;
  }

  /** Get a flow by its ID. */
  get(id: number): CapturedFlow | undefined {
    return this.flows.find((f) => f.id === id);
  }

  /** List flows with optional filtering. */
  list(options: FilterOptions = {}): { flows: CapturedFlow[]; total: number } {
    let filtered = this.flows;

    if (options.urlPattern) {
      const pattern = options.urlPattern;
      try {
        const regex = new RegExp(pattern, "i");
        filtered = filtered.filter((f) => regex.test(f.request.url));
      } catch {
        // Fall back to substring match if not valid regex
        const lower = pattern.toLowerCase();
        filtered = filtered.filter((f) => f.request.url.toLowerCase().includes(lower));
      }
    }

    if (options.method) {
      const method = options.method.toUpperCase();
      filtered = filtered.filter((f) => f.request.method === method);
    }

    if (options.statusMin !== undefined) {
      filtered = filtered.filter((f) => (f.response?.status ?? 0) >= options.statusMin!);
    }

    if (options.statusMax !== undefined) {
      filtered = filtered.filter((f) => (f.response?.status ?? 0) <= options.statusMax!);
    }

    const total = filtered.length;
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 20;

    // Return newest first
    const page = filtered.slice().reverse().slice(offset, offset + limit);

    return { flows: page, total };
  }

  /** Get the parsed JSON body of a flow's response, with lazy parsing. */
  getParsedJson(flow: CapturedFlow): { ok: true; value: unknown } | { ok: false; error: string } {
    if (!flow.response?.body) {
      return { ok: false, error: "No response body available" };
    }

    if (flow._jsonParseAttempted) {
      if (flow._parsedJson !== undefined) {
        return { ok: true, value: flow._parsedJson };
      }
      return { ok: false, error: "Response body is not valid JSON" };
    }

    flow._jsonParseAttempted = true;

    try {
      flow._parsedJson = JSON.parse(flow.response.body);
      return { ok: true, value: flow._parsedJson };
    } catch {
      return { ok: false, error: "Response body is not valid JSON" };
    }
  }

  /** Total number of stored flows. */
  get size(): number {
    return this.flows.length;
  }

  /** Clear all stored flows. */
  clear(): void {
    this.flows = [];
  }
}
