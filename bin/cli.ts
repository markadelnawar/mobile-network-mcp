#!/usr/bin/env node

import { startServer, CAPTURE_SOURCES } from "../src/index.js";
import type { CaptureSource } from "../src/index.js";
import { buildProxymanScript } from "../src/scripts/proxyman-script.js";
import { buildMcpConfigHelp } from "../src/scripts/mcp-config.js";
import { runInit } from "../src/scripts/init.js";

interface ParsedArgs {
  port: number;
  host: string;
  maxFlows: number;
  source: CaptureSource;
  domains: string[];
  proxymanCliPath?: string;
  pollInterval?: number;
  ignoreUrls: string[];
  ingestPort?: number;
  printProxymanScript: boolean;
  printMcpConfig: boolean;
  // init only
  write: boolean;
  client: "claude" | "codex" | "both";
}

function parseArgs(args: string[]): ParsedArgs {
  let port = parseInt(process.env.RN_METRO_PORT ?? "8081", 10);
  let host = process.env.RN_METRO_HOST ?? "localhost";
  let maxFlows = parseInt(process.env.RN_MCP_MAX_FLOWS ?? "500", 10);
  let source = (process.env.RN_MCP_SOURCE ?? "auto") as CaptureSource;
  let proxymanCliPath: string | undefined = process.env.RN_PROXYMAN_CLI;
  let pollInterval: number | undefined = process.env.RN_POLL_INTERVAL
    ? parseInt(process.env.RN_POLL_INTERVAL, 10)
    : undefined;
  let ingestPort: number | undefined = process.env.RN_INGEST_PORT
    ? parseInt(process.env.RN_INGEST_PORT, 10)
    : undefined;
  const domains: string[] = [];
  const ignoreUrls: string[] = [];
  let printProxymanScript = false;
  let printMcpConfig = false;
  let write = false;
  let client: ParsedArgs["client"] = "claude";

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--port":
      case "-p":
        port = parseInt(args[++i], 10);
        break;
      case "--host":
        host = args[++i];
        break;
      case "--max-flows":
        maxFlows = parseInt(args[++i], 10);
        break;
      case "--source":
      case "-s":
        source = args[++i] as CaptureSource;
        break;
      case "--domain":
      case "-d":
        domains.push(args[++i]);
        break;
      case "--proxyman-cli":
        proxymanCliPath = args[++i];
        break;
      case "--poll-interval":
        pollInterval = parseInt(args[++i], 10);
        break;
      case "--ignore-url":
      case "-i":
        ignoreUrls.push(args[++i]);
        break;
      case "--ingest-port":
        ingestPort = parseInt(args[++i], 10);
        break;
      case "--print-proxyman-script":
        printProxymanScript = true;
        break;
      case "--print-mcp-config":
        printMcpConfig = true;
        break;
      case "--write":
        write = true;
        break;
      case "--client":
        client = args[++i] as ParsedArgs["client"];
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
    }
  }

  if (!CAPTURE_SOURCES.includes(source)) {
    console.error(`Unknown --source "${source}". Expected one of: ${CAPTURE_SOURCES.join(", ")}`);
    process.exit(1);
  }
  if ((source === "cdp" || source === "auto") && (isNaN(port) || port <= 0)) {
    console.error("Invalid port number");
    process.exit(1);
  }
  if (!["claude", "codex", "both"].includes(client)) {
    console.error(`Unknown --client "${client}". Expected claude, codex, or both`);
    process.exit(1);
  }

  return { port, host, maxFlows, source, domains, proxymanCliPath, pollInterval, ignoreUrls, ingestPort, printProxymanScript, printMcpConfig, write, client };
}

function printHelp(): void {
  console.log(`
mobile-network-mcp — Token-efficient network MCP server for mobile apps

Usage:
  mobile-network-mcp [options]          Run the MCP server (launched by your MCP client)
  mobile-network-mcp init [options]     Inspect this project + machine, pick the capture
                                        door, print the MCP config (--write saves .mcp.json)

Capture source:
  --source, -s <source>     "auto" (default), "cdp", "ingest", or "proxyman" (env: RN_MCP_SOURCE)
                            auto: ingest server always runs + attach to Metro's inspector when a
                            React Native 0.83+ app is there (CDP); older runtimes fall back to ingest.

Ingest API (always runs on all modes):
  --ingest-port <port>      Ingest HTTP port (default: 7890, env: RN_INGEST_PORT)
  --ignore-url, -i <regex>  Ignore URLs matching pattern (repeatable)

Proxyman options:
  --domain, -d <domain>     Filter by domain (repeatable)
  --proxyman-cli <path>     Path to proxyman-cli (env: RN_PROXYMAN_CLI)
  --poll-interval <ms>      Polling interval in ms (default: 2000, env: RN_POLL_INTERVAL)

CDP options (React Native 0.83+, used by auto/cdp):
  --port, -p <port>         Metro bundler port (default: 8081, env: RN_METRO_PORT)
  --host <host>             Metro bundler host (default: localhost, env: RN_METRO_HOST)

init options:
  --write                   Write/merge the Claude Code config into ./.mcp.json
  --client <name>           claude (default), codex, or both

General:
  --max-flows <count>       Max stored requests (default: 500, env: RN_MCP_MAX_FLOWS)
  --print-proxyman-script   Print the Proxyman scripting interceptor (with the
                            ingest port injected) and exit. Paste it into
                            Proxyman > Tools > Scripting.
  --print-mcp-config        Print ready-to-paste MCP config for Claude Code and
                            Codex (with the ingest port) and exit.
  --help, -h                Show this help

Examples:
  # Decide + configure in one go (run in your app's repo)
  npx mobile-network-mcp init --write

  # Default (auto): CDP on RN 0.83+, ingest otherwise
  mobile-network-mcp -i "tracking|analytics"

  # Proxyman CLI polling mode
  mobile-network-mcp --source proxyman -d api.example.com

  # Force the Metro/CDP door on a non-default port
  mobile-network-mcp --source cdp --port 8082

App interceptors (only needed when the door is "ingest"):
  React Native:  if (__DEV__) require('mobile-network-mcp/interceptor');
  iOS:           NetworkInterceptor.start()      // see interceptors/ios.swift
  Android:       client.addInterceptor(...)       // see interceptors/android.kt
  Flutter:       dio.interceptors.add(...)        // see interceptors/flutter.dart
  Proxyman:      paste interceptors/proxyman.js into Proxyman Script Editor
`);
}

const argv = process.argv.slice(2);
const command = argv[0] === "init" ? "init" : "serve";
const parsed = parseArgs(command === "init" ? argv.slice(1) : argv);

if (command === "init") {
  runInit({
    cwd: process.cwd(),
    metroHost: parsed.host,
    metroPort: parsed.port,
    ingestPort: parsed.ingestPort ?? 7890,
    ignoreUrls: parsed.ignoreUrls,
    write: parsed.write,
    client: parsed.client,
  })
    .then((report) => {
      console.log(report);
      process.exit(0);
    })
    .catch((err) => {
      console.error("init failed:", err);
      process.exit(1);
    });
} else if (parsed.printProxymanScript) {
  console.log(buildProxymanScript(parsed.ingestPort ?? 7890));
  process.exit(0);
} else if (parsed.printMcpConfig) {
  console.log(buildMcpConfigHelp({
    ingestPort: parsed.ingestPort ?? 7890,
    source: parsed.source,
    domains: parsed.domains,
    ignoreUrls: parsed.ignoreUrls,
  }));
  process.exit(0);
} else {
  startServer({
    metroPort: parsed.port,
    metroHost: parsed.host,
    maxFlows: parsed.maxFlows,
    source: parsed.source,
    domains: parsed.domains,
    proxymanCliPath: parsed.proxymanCliPath,
    pollInterval: parsed.pollInterval,
    ignoreUrls: parsed.ignoreUrls,
    ingestPort: parsed.ingestPort,
  }).catch((err) => {
    console.error("Failed to start server:", err);
    process.exit(1);
  });
}
