import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { repairTruncatedJson } from "../src/store/json-repair.js";

const doc = { items: [{ id: 1, name: "Café" }, { id: 2, name: "Ñandú" }], total: 2, ok: true };
const full = JSON.stringify(doc);

describe("repairTruncatedJson", () => {
  it("returns intact JSON unchanged", () => {
    assert.deepEqual(repairTruncatedJson(full)?.value, doc);
  });

  it("closes a document cut inside a string", () => {
    const cut = full.slice(0, full.indexOf("Ñandú") + 2); // ...,"name":"Ña
    const r = repairTruncatedJson(cut);
    assert.ok(r);
    const v = r.value as typeof doc;
    assert.equal(v.items.length, 2);
    assert.equal(v.items[1].id, 2);
    assert.equal(v.items[1].name, "Ña"); // shortened, not invented
  });

  it("drops a dangling key when cut right after the colon", () => {
    const cut = full.slice(0, full.indexOf('"total":') + '"total":'.length);
    const r = repairTruncatedJson(cut);
    assert.ok(r);
    const v = r.value as Record<string, unknown>;
    assert.deepEqual(Object.keys(v), ["items"]);
    assert.ok(r.droppedChars > 0);
  });

  it("drops a partial key when cut inside the key name", () => {
    const cut = full.slice(0, full.indexOf('"total"') + 4); // {"items":[...],"tot
    const v = repairTruncatedJson(cut)?.value as Record<string, unknown>;
    assert.deepEqual(Object.keys(v), ["items"]);
  });

  it("closes nested arrays and objects cut after a comma", () => {
    const cut = '{"a":[1,2,{"x":[true,false,';
    assert.deepEqual(repairTruncatedJson(cut)?.value, { a: [1, 2, { x: [true, false] }] });
  });

  it("handles escaped quotes inside strings", () => {
    const cut = '{"msg":"he said \\"hi\\", then","next":[1';
    assert.deepEqual(repairTruncatedJson(cut)?.value, { msg: 'he said "hi", then', next: [1] });
  });

  it("gives up on bodies that are not JSON", () => {
    assert.equal(repairTruncatedJson("<html><body>nope</body></html>"), undefined);
    assert.equal(repairTruncatedJson(""), undefined);
  });
});
