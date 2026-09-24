#!/usr/bin/env bun
import type { DaniFreeConfig } from "./config";
import { applyBackendEnvironment, loadConfig } from "./config";
import { ModelCatalog } from "./catalog";
import { startRefreshScheduler } from "./refresh-scheduler";
import { catalogAdapters, startServer } from "./server";
import { fallbackPorts, listenWithFallback, loadOrCreateInstallKey, readInstallKey, readLiveRuntime, removeRuntime, writeRuntime } from "./install";

const HELP = `Usage: dani-free <command> [options]

Commands:
  start    Start the local OpenAI-compatible router in the foreground
  status   Check the local router health endpoint
  models   List models exposed by the local router
  refresh  Re-check every backend for new or removed models now
  key      Print the path of this install's client key file
  doctor   Check router health and model discovery

Options:
  --config <path>  Use a specific JSON config file
  --host <host>    Override the host (listen host for start, router endpoint for the rest)
  --port <port>    Override the port (listen port for start, router endpoint for the rest)
  --help           Show this help
`;

interface ParsedArgs {
  command?: string;
  configPath?: string;
  host?: string;
  port?: number;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  if (command === "--help" || command === "-h") return { command: "help" };
  const parsed: ParsedArgs = { command };
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === "--help" || argument === "-h") {
      parsed.command = parsed.command ?? "help";
      continue;
    }
    if (argument === "--config") {
      const value = rest[++index];
      if (!value) throw new Error("--config requires a path");
      parsed.configPath = value;
      continue;
    }
    if (argument === "--host") {
      const value = rest[++index];
      if (!value) throw new Error("--host requires a value");
      parsed.host = value;
      continue;
    }
    if (argument === "--port") {
      const value = rest[++index];
      if (!value) throw new Error("--port requires a value");
      const port = Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("--port must be an integer between 1 and 65535");
      parsed.port = port;
      continue;
    }
    throw new Error(`unknown option: ${argument}`);
  }
  return parsed;
}

function endpoint(config: DaniFreeConfig): string {
  const host = config.host.includes(":") && !config.host.startsWith("[") ? `[${config.host}]` : config.host;
  return `http://${host}:${config.port}`;
}

function authHeaders(config: DaniFreeConfig): HeadersInit {
  if (!config.apiKey) return { accept: "application/json" };
  return { accept: "application/json", authorization: `Bearer ${config.apiKey}`, "x-api-key": config.apiKey };
}

async function fetchJson(config: DaniFreeConfig, path: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  try {
    const response = await fetch(`${endpoint(config)}${path}`, { headers: authHeaders(config), signal: controller.signal });
    if (!response.ok) throw new Error(`router returned HTTP ${response.status} ${response.statusText}`);
    try {
      return await response.json();
    } catch {
      throw new Error(`router returned invalid JSON for ${path}`);
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error(`request to ${path} timed out after ${config.requestTimeoutMs}ms`);
    if (error instanceof Error && (error.message.startsWith("router returned") || error.message.startsWith("request to"))) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot reach router at ${endpoint(config)}: ${detail}`);
  } finally {
    clearTimeout(timer);
  }
}

function configSecrets(config: DaniFreeConfig): string[] {
  const secrets = [config.apiKey];
  for (const backend of Object.values(config.backends)) secrets.push(backend.apiKey);
  return secrets.filter((secret): secret is string => Boolean(secret));
}

function printJson(value: unknown, secrets: string[] = []): void {
  const serialized = JSON.stringify(value, (key, nested) => {
    if (/^(api[-_]?key|authorization|access[-_]?token|refresh[-_]?token|token|secret|password|credential)$/i.test(key)) {
      return nested === undefined ? undefined : "[redacted]";
    }
    if (typeof nested === "string") {
      return secrets.reduce((safe, secret) => safe.replaceAll(secret, "[redacted]"), nested);
    }
    return nested;
  }, 2);
  console.log(serialized ?? "null");
}

function selectHealth(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const backends = Array.isArray(record.backends)
    ? record.backends.map((backend) => {
      if (!backend || typeof backend !== "object") return backend;
      const item = backend as Record<string, unknown>;
      return { backend: item.backend, configured: item.configured, healthy: item.healthy, reason: item.reason, latencyMs: item.latencyMs };
    })
    : record.backends;
  return { status: record.status, ok: record.ok, checkedAt: record.checkedAt, backends };
}

function modelsFrom(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && "data" in value && Array.isArray(value.data)) return value.data;
  return undefined;
}

async function runStatus(config: DaniFreeConfig): Promise<number> {
  const health = await fetchJson(config, "/health");
  printJson(selectHealth(health), configSecrets(config));
  return 0;
}
async function runModels(config: DaniFreeConfig): Promise<number> {
  const response = await fetchJson(config, "/v1/models");
  const models = modelsFrom(response);
  if (!Array.isArray(models)) throw new Error("router returned an invalid model list");
  printJson(models.map((model) => {
    if (!model || typeof model !== "object") return model;
    const item = model as Record<string, unknown>;
    return { id: item.id, backend: item.backend, name: item.name, capabilities: item.capabilities, contextWindow: item.contextWindow, maxTokens: item.maxTokens, healthy: item.healthy, new: item.new, default: item.default };
  }), configSecrets(config));
  return 0;
}

async function runDoctor(config: DaniFreeConfig): Promise<number> {
  let failed = false;
  try {
    const health = await fetchJson(config, "/health");
    console.log("router: reachable");
    printJson(selectHealth(health), configSecrets(config));
    if (health && typeof health === "object" && (health as Record<string, unknown>).ok === false) failed = true;
  } catch (error) {
    failed = true;
    console.error(`router: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const response = await fetchJson(config, "/v1/models");
    const models = modelsFrom(response) ?? [];
    console.log(`models: ${models.length} available`);
    if (models.length === 0) failed = true;
  } catch (error) {
    failed = true;
    console.error(`models: ${error instanceof Error ? error.message : String(error)}`);
  }
  return failed ? 1 : 0;
}
async function runRefresh(config: DaniFreeConfig): Promise<number> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(config.requestTimeoutMs, 120_000));
  try {
    const headers = new Headers(authHeaders(config));
    const response = await fetch(`${endpoint(config)}/v1/models/refresh`, { method: "POST", headers, signal: controller.signal });
    const body = await response.json().catch(() => undefined);
    if (!response.ok) throw new Error(`router returned HTTP ${response.status}`);
    printJson(body, configSecrets(config));
    return 0;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error("refresh timed out");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function runStart(config: DaniFreeConfig): Promise<number> {
  applyBackendEnvironment(config);
  const catalog = new ModelCatalog({ path: config.catalogPath });
  // Per-install key unless one is configured or auth is explicitly off.
  const usingInstallKey = !config.apiKey && config.requireKey;
  const apiKey = config.apiKey ?? (config.requireKey ? loadOrCreateInstallKey(config.apiKeyFile) : undefined);
  if (!apiKey) console.error("dani-free: client auth is OFF (DANI_FREE_NO_AUTH=1): any local process can use this proxy");
  const ports = config.strictPort ? [config.port] : fallbackPorts(config.port);
  const listened = listenWithFallback(ports, (port) => startServer({
    catalog,
    adapters: catalogAdapters(),
    probeOnRefresh: config.probeOnRefresh,
    privateMode: config.privateMode,
    host: config.host,
    port,
    apiKey,
    timeoutMs: config.requestTimeoutMs,
    attemptTimeoutMs: config.attemptTimeoutMs,
    maxBodyBytes: config.bodyLimitBytes,
  }));
  const started = listened.value;
  config.port = started.port;
  const baseUrl = `${endpoint(config)}/v1`;
  if (listened.fellBack) console.error(`dani-free: port ${ports[0]} was busy, using ${started.port}`);
  writeRuntime(config.runtimePath, {
    pid: process.pid,
    host: config.host,
    port: started.port,
    baseUrl,
    startedAt: new Date().toISOString(),
    apiKeyFile: usingInstallKey ? config.apiKeyFile : undefined,
    privateMode: config.privateMode,
  });
  console.log(`dani-free listening at ${endpoint(config)}`);
  // One machine-readable line for the embedding app: where to connect and where the key is. Never the key itself.
  console.log(`DANI_FREE_READY ${JSON.stringify({ baseUrl, port: started.port, pid: process.pid, apiKeyFile: usingInstallKey ? config.apiKeyFile : null, privateMode: config.privateMode })}`);
  // Boot-time refresh plus a daily one. Chat is served from the saved catalog
  // (or live discovery on a first run) while the refresh runs.
  const scheduler = startRefreshScheduler(() => started.router.refreshCatalog(), {
    intervalMs: config.refreshIntervalHours * 60 * 60 * 1000,
    onResult: (summary) => {
      if (!summary) return;
      const note = summary.backendErrors.length ? ` (backend errors: ${summary.backendErrors.map((item) => item.backend).join(", ")})` : "";
      console.log(`[catalog] refreshed: ${summary.visible}/${summary.total} models usable, +${summary.added.length} new, -${summary.removed.length} gone${note}`);
    },
    onError: (error) => console.error(`[catalog] refresh failed: ${error instanceof Error ? error.message : String(error)}`),
  });
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    scheduler.stop();
    removeRuntime(config.runtimePath);
    started.close(true);
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await new Promise<void>(() => undefined);
  return 0;
}

export async function main(argv = Bun.argv.slice(2)): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.command || parsed.command === "help") {
    console.log(HELP);
    return 0;
  }
  const config = loadConfig(parsed.configPath);
  if (parsed.host !== undefined) config.host = parsed.host;
  if (parsed.port !== undefined) config.port = parsed.port;
  if (parsed.command !== "start") {
    // Client commands follow the running proxy (it may have moved port) and use this install's key.
    const runtime = readLiveRuntime(config.runtimePath);
    if (runtime && parsed.port === undefined && process.env.DANI_FREE_PORT === undefined) config.port = runtime.port;
    if (!config.apiKey) config.apiKey = readInstallKey(config.apiKeyFile);
  }
  switch (parsed.command) {
    case "start": return runStart(config);
    case "status": return runStatus(config);
    case "models": return runModels(config);
    case "refresh": return runRefresh(config);
    case "key": console.log(config.apiKeyFile); return 0;
    case "doctor": return runDoctor(config);
    default: throw new Error(`unknown command: ${parsed.command}`);
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(`dani-free: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
