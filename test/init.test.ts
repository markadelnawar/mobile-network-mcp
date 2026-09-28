import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide, detectProject, supportsCdp, writeClaudeConfig, runInit } from "../src/scripts/init.js";

const metroUp = { reachable: true, targets: 1, reactNativeTarget: true };
const metroDown = { reachable: false, targets: 0, reactNativeTarget: false };

describe("init: supportsCdp", () => {
  it("is true from React Native 0.83", () => {
    assert.equal(supportsCdp("0.83.0"), true);
    assert.equal(supportsCdp("0.87.1"), true);
    assert.equal(supportsCdp("1.0.0"), true);
    assert.equal(supportsCdp("0.82.4"), false);
    assert.equal(supportsCdp("0.77.3"), false);
    assert.equal(supportsCdp(undefined), false);
  });
});

describe("init: decide", () => {
  it("picks CDP (auto) for React Native ≥ 0.83 and warns against double capture", () => {
    const d = decide({ reactNativeVersion: "0.87.1" }, metroUp, false, 8081);
    assert.equal(d.door, "cdp");
    assert.equal(d.source, "auto");
    assert.ok(d.steps.some((s) => /interceptor\.js/.test(s) && /twice/.test(s)));
  });

  it("tells the user Metro is down but the server will wait", () => {
    const d = decide({ reactNativeVersion: "0.87.1" }, metroDown, false, 8082);
    assert.ok(d.steps.some((s) => /:8082/.test(s) && /retrying/.test(s)));
  });

  it("picks ingest for older React Native and points at the interceptor", () => {
    const d = decide({ reactNativeVersion: "0.77.3" }, metroUp, true, 8081);
    assert.equal(d.door, "ingest");
    assert.equal(d.source, "ingest");
    assert.ok(d.steps[0].includes("require('mobile-network-mcp/interceptor')"));
    assert.ok(d.steps.some((s) => /--source proxyman/.test(s)));
  });

  it("picks Proxyman polling for non-RN projects when proxyman-cli exists, ingest otherwise", () => {
    assert.equal(decide({ name: "ios-app" }, metroDown, true, 8081).source, "proxyman");
    assert.equal(decide({ name: "ios-app" }, metroDown, false, 8081).source, "ingest");
  });

  it("prefers CDP when Metro already shows an attached React Native app, even outside the RN repo", () => {
    const d = decide({ name: "some-tooling-repo" }, metroUp, true, 8081);
    assert.equal(d.door, "cdp");
    assert.equal(d.source, "auto");
    assert.match(d.reason, /Metro on :8081 has a React Native app attached/);
  });
});

describe("init: project detection + config writing", () => {
  it("reads the react-native version from package.json (range prefixes stripped)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mnm-init-"));
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "demo", dependencies: { "react-native": "^0.87.1", expo: "~54.0.0" } }));
    assert.deepEqual(await detectProject(dir), { name: "demo", reactNativeVersion: "0.87.1", expoVersion: "54.0.0" });
    assert.deepEqual(await detectProject(join(dir, "nope")), {});
  });

  it("merges into an existing .mcp.json without touching other servers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mnm-init-"));
    await writeFile(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }));
    const { created } = await writeClaudeConfig(dir, ["-y", "mobile-network-mcp", "-i", "tracking"]);
    assert.equal(created, false);
    const written = JSON.parse(await readFile(join(dir, ".mcp.json"), "utf8"));
    assert.deepEqual(written.mcpServers.other, { command: "x" });
    assert.deepEqual(written.mcpServers["mobile-network-mcp"], { command: "npx", args: ["-y", "mobile-network-mcp", "-i", "tracking"] });
  });

  it("runInit reports the decision and, with --write, the file it wrote", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mnm-init-"));
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "demo", dependencies: { "react-native": "0.87.1" } }));
    const report = await runInit({
      cwd: dir,
      metroHost: "localhost",
      metroPort: 8081,
      ingestPort: 7890,
      ignoreUrls: [],
      write: true,
      client: "both",
      probe: async () => metroUp,
      proxymanCliPath: join(dir, "no-such-cli"),
    });
    assert.match(report, /React Native 0\.87\.1/);
    assert.match(report, /Capture door: CDP via Metro's inspector \(--source auto, the default\)/);
    assert.match(report, /wrote .*\.mcp\.json/);
    assert.match(report, /\[mcp_servers\.mobile-network-mcp\]/);
    const written = JSON.parse(await readFile(join(dir, ".mcp.json"), "utf8"));
    // auto is the default → no --source in args; default ignore list applied
    assert.deepEqual(written.mcpServers["mobile-network-mcp"].args, ["-y", "mobile-network-mcp", "--ingest-port", "7890", "-i", "tracking|analytics|adtracker|symbolicate"]);
  });
});
