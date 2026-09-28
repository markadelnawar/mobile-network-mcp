/**
 * `mobile-network-mcp init` — look at the project and the machine, say which
 * capture door will do the work, print (or write) the MCP config, and list the
 * one or two steps the developer still has to do.
 *
 * The runtime decision itself lives in `--source auto` (CDP when Metro exposes a
 * React Native 0.83+ app, ingest otherwise); `init` explains that decision up
 * front so nobody wonders why the store stays empty.
 */
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CLI_PATH } from "../capture/proxyman-capture.js";
import { buildArgs, buildClaudeConfig, buildCodexConfig } from "./mcp-config.js";

export interface ProjectInfo {
  name?: string;
  reactNativeVersion?: string;
  expoVersion?: string;
}

export interface MetroProbe {
  reachable: boolean;
  targets: number;
  reactNativeTarget: boolean;
}

export type Door = "cdp" | "ingest" | "proxyman";

export interface Decision {
  door: Door;
  /** What to put in `--source` (omitted from args when "auto"). */
  source: "auto" | "ingest" | "proxyman";
  reason: string;
  steps: string[];
}

export interface InitOptions {
  cwd: string;
  metroHost: string;
  metroPort: number;
  ingestPort: number;
  ignoreUrls: string[];
  /** Write/merge `.mcp.json` in cwd (Claude Code project scope). */
  write: boolean;
  client: "claude" | "codex" | "both";
  /** Test seams. */
  probe?: (host: string, port: number) => Promise<MetroProbe>;
  proxymanCliPath?: string;
}

const CDP_MIN_MINOR = 83;

export async function detectProject(cwd: string): Promise<ProjectInfo> {
  try {
    const pkg = JSON.parse(await readFile(join(cwd, "package.json"), "utf8")) as {
      name?: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...(pkg.devDependencies ?? {}), ...(pkg.dependencies ?? {}) };
    return {
      name: pkg.name,
      reactNativeVersion: cleanVersion(deps["react-native"]),
      expoVersion: cleanVersion(deps["expo"]),
    };
  } catch {
    return {};
  }
}

function cleanVersion(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const m = v.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  return m ? m[0] : v;
}

export function parseVersion(v: string | undefined): { major: number; minor: number } | undefined {
  const m = v?.match(/(\d+)\.(\d+)/);
  return m ? { major: parseInt(m[1], 10), minor: parseInt(m[2], 10) } : undefined;
}

/** Hermes gained the CDP Network domain in React Native 0.83. */
export function supportsCdp(reactNativeVersion: string | undefined): boolean {
  const v = parseVersion(reactNativeVersion);
  return !!v && (v.major > 0 || v.minor >= CDP_MIN_MINOR);
}

export async function probeMetro(host: string, port: number, timeoutMs = 1500): Promise<MetroProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://${host}:${port}/json`, { signal: controller.signal });
    if (!res.ok) return { reachable: true, targets: 0, reactNativeTarget: false };
    const targets = (await res.json()) as Array<{ title?: string; description?: string; type?: string }>;
    const rn = targets.some(
      (t) => (t.description ?? "").includes("React Native") || (t.title ?? "").includes("React Native") || t.type === "node",
    );
    return { reachable: true, targets: targets.length, reactNativeTarget: rn };
  } catch {
    return { reachable: false, targets: 0, reactNativeTarget: false };
  } finally {
    clearTimeout(timer);
  }
}

export function decide(project: ProjectInfo, metro: MetroProbe | undefined, hasProxymanCli: boolean, metroPort: number): Decision {
  const rn = project.reactNativeVersion;
  if (rn && supportsCdp(rn)) {
    const steps = [
      `Nothing to add to the app: the server attaches to Metro's inspector on :${metroPort} and reads fetch/XHR traffic from there.`,
      "Do not also add interceptor.js or the Proxyman script for the same app — every request would be stored twice.",
    ];
    if (metro && !metro.reachable) {
      steps.push(`Metro is not running on :${metroPort} right now; the server keeps retrying every 3 s until the app appears.`);
    } else if (metro && metro.reachable && !metro.reactNativeTarget) {
      steps.push("Metro is up but no app is attached yet; launch the app (dev build) and capture starts by itself.");
    }
    return {
      door: "cdp",
      source: "auto",
      reason: `React Native ${rn} (≥ 0.${CDP_MIN_MINOR}): Hermes exposes the CDP Network domain through Metro.`,
      steps,
    };
  }
  if (rn) {
    const steps = [
      "Add the in-app interceptor as early as possible in your dev entry (index.js):\n     if (__DEV__) require('mobile-network-mcp/interceptor');",
      "Or, to also see native traffic, paste the Proxyman script: mobile-network-mcp --print-proxyman-script",
    ];
    if (hasProxymanCli) steps.push("Proxyman is installed: `--source proxyman -d <api host>` polls it instead (no script, no app change).");
    return {
      door: "ingest",
      source: "ingest",
      reason: `React Native ${rn} is older than 0.${CDP_MIN_MINOR}: Hermes has no CDP Network domain, so requests must be pushed to the ingest server.`,
      steps,
    };
  }
  if (metro?.reactNativeTarget) {
    return {
      door: "cdp",
      source: "auto",
      reason: `No react-native in this directory's package.json, but Metro on :${metroPort} has a React Native app attached — CDP will be used while it is 0.83+ (auto falls back to ingest otherwise).`,
      steps: [
        "Run init from the app's own repo to get a version-aware answer.",
        "Nothing to add to the app for CDP; add interceptor.js only if the server reports CDP unavailable.",
      ],
    };
  }
  const steps = [
    "Paste the Proxyman script (captures everything, including native SDKs): mobile-network-mcp --print-proxyman-script",
    "Native iOS/Android/Flutter interceptors live on the feature/platform-interceptors branch.",
  ];
  if (hasProxymanCli) {
    return {
      door: "proxyman",
      source: "proxyman",
      reason: "Not a React Native project, and Proxyman is installed: polling proxyman-cli needs no app change.",
      steps: [`Scope the poll with -d <api host> in the config args.`, ...steps],
    };
  }
  return {
    door: "ingest",
    source: "ingest",
    reason: "Not a React Native project (no react-native in package.json): traffic has to be pushed to the ingest server.",
    steps,
  };
}

export async function writeClaudeConfig(cwd: string, args: string[]): Promise<{ path: string; created: boolean }> {
  const path = join(cwd, ".mcp.json");
  let existing: { mcpServers?: Record<string, unknown> } = {};
  let created = true;
  try {
    existing = JSON.parse(await readFile(path, "utf8"));
    created = false;
  } catch {
    // no file yet (or unreadable JSON — we overwrite only our own entry below)
  }
  const merged = {
    ...existing,
    mcpServers: { ...(existing.mcpServers ?? {}), "mobile-network-mcp": { command: "npx", args } },
  };
  await writeFile(path, JSON.stringify(merged, null, 2) + "\n", "utf8");
  return { path, created };
}

export async function runInit(opts: InitOptions): Promise<string> {
  const project = await detectProject(opts.cwd);
  const metro = await (opts.probe ?? probeMetro)(opts.metroHost, opts.metroPort);
  const proxymanCli = opts.proxymanCliPath ?? DEFAULT_CLI_PATH;
  const hasProxymanCli = existsSync(proxymanCli);
  const decision = decide(project, metro, hasProxymanCli, opts.metroPort);

  const configOpts = {
    ingestPort: opts.ingestPort,
    source: decision.source,
    ignoreUrls: opts.ignoreUrls,
  };
  const args = buildArgs(configOpts);

  const lines: string[] = [];
  lines.push("mobile-network-mcp init", "");
  lines.push(`Project:      ${project.name ?? "(no package.json)"}${project.reactNativeVersion ? ` — React Native ${project.reactNativeVersion}` : ""}${project.expoVersion ? ` (Expo ${project.expoVersion})` : ""}`);
  lines.push(
    `Metro:        http://${opts.metroHost}:${opts.metroPort} — ${
      metro.reachable ? `reachable, ${metro.targets} target(s)${metro.reactNativeTarget ? " (React Native app attached)" : ""}` : "not reachable"
    }`,
  );
  lines.push(`Proxyman CLI: ${hasProxymanCli ? `found (${proxymanCli})` : "not found"}`, "");
  lines.push(`Capture door: ${describeDoor(decision.door)}${decision.source === "auto" ? " (--source auto, the default)" : ` (--source ${decision.source})`}`);
  lines.push(`Why:          ${decision.reason}`, "", "Next steps:");
  decision.steps.forEach((s, i) => lines.push(`  ${i + 1}. ${s}`));
  lines.push("");

  if (opts.client === "claude" || opts.client === "both") {
    if (opts.write) {
      const { path, created } = await writeClaudeConfig(opts.cwd, args);
      lines.push(`## Claude Code — ${created ? "wrote" : "updated"} ${path}`, "", buildClaudeConfig(configOpts), "", "Restart Claude Code (or /mcp → reconnect) so it picks up the server.", "");
    } else {
      lines.push("## Claude Code — add to .mcp.json (or rerun with --write)", "", buildClaudeConfig(configOpts), "");
    }
  }
  if (opts.client === "codex" || opts.client === "both") {
    lines.push("## Codex — add to ~/.codex/config.toml", "", buildCodexConfig(configOpts), "");
  }
  return lines.join("\n");
}

function describeDoor(door: Door): string {
  switch (door) {
    case "cdp":
      return "CDP via Metro's inspector";
    case "proxyman":
      return "Proxyman CLI polling";
    default:
      return "ingest server (interceptor / Proxyman script push)";
  }
}
