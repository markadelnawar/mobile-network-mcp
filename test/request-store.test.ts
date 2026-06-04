import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RequestStore } from "../src/store/request-store.js";
import type { CapturedFlow } from "../src/capture/types.js";

function makeFlow(overrides: Partial<CapturedFlow> = {}): CapturedFlow {
  return {
    id: 0,
    request: {
      url: "https://api.example.com/users",
      method: "GET",
      headers: {},
      timestamp: Date.now() / 1000,
    },
    response: {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json" },
      mimeType: "application/json",
      body: '{"data": [1, 2, 3]}',
      bodySize: 19,
      encodedDataLength: 19,
    },
    timing: { startTime: Date.now(), endTime: Date.now() + 100, duration: 100 },
    ...overrides,
  };
}

describe("RequestStore", () => {
  it("assigns auto-incrementing IDs", () => {
    const store = new RequestStore();
    const f1 = store.add(makeFlow());
    const f2 = store.add(makeFlow());
    assert.equal(f1.id, 1);
    assert.equal(f2.id, 2);
  });

  it("retrieves by ID", () => {
    const store = new RequestStore();
    store.add(makeFlow());
    const f2 = store.add(makeFlow());
    const found = store.get(f2.id);
    assert.ok(found);
    assert.equal(found.id, f2.id);
  });

  it("evicts oldest when over capacity", () => {
    const store = new RequestStore(3);
    store.add(makeFlow());
    store.add(makeFlow());
    store.add(makeFlow());
    store.add(makeFlow()); // This should evict the first one

    assert.equal(store.size, 3);
    assert.equal(store.get(1), undefined); // Evicted
    assert.ok(store.get(2)); // Still present
  });

  it("filters by URL pattern", () => {
    const store = new RequestStore();
    store.add(makeFlow({ request: { url: "https://api.example.com/users", method: "GET", headers: {}, timestamp: 0 } }));
    store.add(makeFlow({ request: { url: "https://api.example.com/products", method: "GET", headers: {}, timestamp: 0 } }));
    store.add(makeFlow({ request: { url: "https://api.example.com/users/1", method: "GET", headers: {}, timestamp: 0 } }));

    const { flows, total } = store.list({ urlPattern: "users" });
    assert.equal(total, 2);
    assert.ok(flows.every((f) => f.request.url.includes("users")));
  });

  it("filters by method", () => {
    const store = new RequestStore();
    store.add(makeFlow({ request: { url: "https://api.example.com/users", method: "GET", headers: {}, timestamp: 0 } }));
    store.add(makeFlow({ request: { url: "https://api.example.com/users", method: "POST", headers: {}, timestamp: 0 } }));

    const { flows } = store.list({ method: "POST" });
    assert.equal(flows.length, 1);
    assert.equal(flows[0].request.method, "POST");
  });

  it("filters by status range", () => {
    const store = new RequestStore();
    store.add(makeFlow({ response: { status: 200, statusText: "OK", headers: {}, mimeType: "", bodySize: 0, encodedDataLength: 0 } }));
    store.add(makeFlow({ response: { status: 404, statusText: "Not Found", headers: {}, mimeType: "", bodySize: 0, encodedDataLength: 0 } }));
    store.add(makeFlow({ response: { status: 500, statusText: "Error", headers: {}, mimeType: "", bodySize: 0, encodedDataLength: 0 } }));

    const { flows } = store.list({ statusMin: 400 });
    assert.equal(flows.length, 2);
    assert.ok(flows.every((f) => (f.response?.status ?? 0) >= 400));
  });

  it("lazily parses JSON", () => {
    const store = new RequestStore();
    const flow = store.add(makeFlow());

    // First call parses
    const result1 = store.getParsedJson(flow);
    assert.ok(result1.ok);
    assert.deepEqual(result1.value, { data: [1, 2, 3] });

    // Second call uses cache
    const result2 = store.getParsedJson(flow);
    assert.ok(result2.ok);
    assert.equal(result1.value, result2.value); // Same reference
  });

  it("handles non-JSON body gracefully", () => {
    const store = new RequestStore();
    const flow = store.add(
      makeFlow({
        response: {
          status: 200,
          statusText: "OK",
          headers: {},
          mimeType: "text/html",
          body: "<html>not json</html>",
          bodySize: 21,
          encodedDataLength: 21,
        },
      }),
    );

    const result = store.getParsedJson(flow);
    assert.ok(!result.ok);
    assert.ok(result.error.includes("not valid JSON"));
  });
});
