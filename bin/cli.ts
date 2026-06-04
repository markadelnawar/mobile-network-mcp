#!/usr/bin/env node

import { startServer } from "../src/index.js";
import type { CaptureSource } from "../src/index.js";

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
}

function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2);
  let port = parseInt(process.env.RN_METRO_PORT ?? "8081", 10);
  let host = process.env.RN_METRO_HOST ?? "localhost";
  let maxFlows = parseInt(process.env.RN_MCP_MAX_FLOWS ?? "500", 10);
  let source: CaptureSource = (process.env.RN_MCP_SOURCE as CaptureSource) ?? "ingest";
  let proxymanCliPath: string | undefined = process.env.RN_PROXYMAN_CLI;
  let pollInterval: number | undefined = process.env.RN_POLL_INTERVAL
    ? parseInt(process.env.RN_POLL_INTERVAL, 10)
    : undefined;
  let ingestPort: number | undefined = process.env.RN_INGEST_PORT
    ? parseInt(process.env.RN_INGEST_PORT, 10)
    : undefined;
  const domains: string[] = [];
  const ignoreUrls: string[] = [];

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
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
    }
  }

  if (source === "cdp" && (isNaN(port) || port <= 0)) {
    console.error("Invalid port number");
    process.exit(1);
  }

  return { port, host, maxFlows, source, domains, proxymanCliPath, pollInterval, ignoreUrls, ingestPort };
}

function printHelp(): void {
  console.log(`
mobile-network-mcp — Token-efficient network MCP server for mobile apps

Usage:
  mobile-network-mcp [options]

Capture source:
  --source, -s <source>     "ingest", "proxyman", or "cdp" (default: ingest, env: RN_MCP_SOURCE)

Ingest API (always runs on all modes):
  --ingest-port <port>      Ingest HTTP port (default: 7890, env: RN_INGEST_PORT)
  --ignore-url, -i <regex>  Ignore URLs matching pattern (repeatable)

Proxyman options:
  --domain, -d <domain>     Filter by domain (repeatable)
  --proxyman-cli <path>     Path to proxyman-cli (env: RN_PROXYMAN_CLI)
  --poll-interval <ms>      Polling interval in ms (default: 2000, env: RN_POLL_INTERVAL)

CDP options (React Native 0.83+):
  --port, -p <port>         Metro bundler port (default: 8081, env: RN_METRO_PORT)
  --host <host>             Metro bundler host (default: localhost, env: RN_METRO_HOST)

General:
  --max-flows <count>       Max stored requests (default: 500, env: RN_MCP_MAX_FLOWS)
  --help, -h                Show this help

Examples:
  # Ingest mode (default) — use with app interceptor or Proxyman script
  mobile-network-mcp -i "tracking|analytics"

  # Proxyman CLI polling mode
  mobile-network-mcp --source proxyman -d api.example.com

  # CDP mode for React Native 0.83+
  mobile-network-mcp --source cdp --port 8081

App interceptors (add to your app in dev mode):
  React Native:  if (__DEV__) require('mobile-network-mcp/interceptor');
  iOS:           NetworkInterceptor.start()      // see interceptors/ios.swift
  Android:       client.addInterceptor(...)       // see interceptors/android.kt
  Flutter:       dio.interceptors.add(...)        // see interceptors/flutter.dart
  Proxyman:      paste interceptors/proxyman.js into Proxyman Script Editor
`);
}

const parsed = parseArgs();

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
