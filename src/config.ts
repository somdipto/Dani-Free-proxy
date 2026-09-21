import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { BackendId } from "./types";

export interface BackendSettings {
  baseUrl?: string;
  apiKey?: string;
  command?: string;
  timeoutMs?: number;
  [key: string]: unknown;
}

export interface DaniFreeConfig {
  host: string;
  port: number;
  apiKey?: string;
  requestTimeoutMs: number;
  bodyLimitBytes: number;
  configPath: string;
  backends: Record<BackendId, BackendSettings>;
}

interface ConfigFile {
  host?: unknown;
  port?: unknown;
  apiKey?: unknown;
  requestTimeoutMs?: unknown;
  bodyLimitBytes?: unknown;
  backends?: unknown;
  opencode?: unknown;
  kilo?: unknown;
  mimo?: unknown;
}

const DEFAULT_CONFIG_PATH = join(homedir(), ".config", "dani-free", "config.json");
const DEFAULTS: DaniFreeConfig = {
  host: "127.0.0.1",
  port: 4190,
  requestTimeoutMs: 180_000,
  bodyLimitBytes: 4 * 1024 * 1024,
  configPath: DEFAULT_CONFIG_PATH,
  backends: {
    opencode: { baseUrl: "http://127.0.0.1:4187/v1" },
    kilo: { baseUrl: "https://api.kilo.ai/api/gateway" },
    mimo: {},
  },
};

function env(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? undefined : value.trim();
}

function numberValue(value: unknown, name: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function stringValue(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}

function backendValue(value: unknown, name: string): BackendSettings {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  const input = value as Record<string, unknown>;
  const result: BackendSettings = {};
  for (const [key, raw] of Object.entries(input)) {
    if (raw !== undefined) result[key] = raw;
  }
  if (input.baseUrl !== undefined) result.baseUrl = stringValue(input.baseUrl, `${name}.baseUrl`);
  if (input.apiKey !== undefined) result.apiKey = stringValue(input.apiKey, `${name}.apiKey`);
  if (input.command !== undefined) result.command = stringValue(input.command, `${name}.command`);
  if (input.timeoutMs !== undefined) result.timeoutMs = numberValue(input.timeoutMs, `${name}.timeoutMs`, 100, 300_000);
  return result;
}

function readConfigFile(path: string, required: boolean): ConfigFile {
  if (!existsSync(path)) {
    if (required) throw new Error(`config file does not exist: ${path}`);
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot read config file ${path}: ${detail}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`config file ${path} must contain a JSON object`);
  }
  return parsed as ConfigFile;
}

function mergeBackend(file: ConfigFile, id: BackendId): BackendSettings {
  const nested = file.backends && typeof file.backends === "object" && !Array.isArray(file.backends)
    ? (file.backends as Record<string, unknown>)[id]
    : undefined;
  const legacy = file[id];
  return { ...DEFAULTS.backends[id], ...backendValue(legacy, `${id}`), ...backendValue(nested, `backends.${id}`) };
}

/** Load defaults, optional JSON config, then environment overrides. Secrets are never logged by this module. */
export function loadConfig(configPath?: string): DaniFreeConfig {
  const configuredPath = configPath ?? env("DANI_FREE_CONFIG");
  const selectedPath = resolve(configuredPath ?? DEFAULT_CONFIG_PATH);
  const file = readConfigFile(selectedPath, configuredPath !== undefined);
  const host = env("DANI_FREE_HOST") ?? stringValue(file.host, "host") ?? DEFAULTS.host;
  const port = numberValue(env("DANI_FREE_PORT") ?? file.port, "port", 1, 65_535) ?? DEFAULTS.port;
  const requestTimeoutMs = numberValue(env("DANI_FREE_REQUEST_TIMEOUT_MS") ?? file.requestTimeoutMs, "requestTimeoutMs", 100, 300_000) ?? DEFAULTS.requestTimeoutMs;
  const bodyLimitBytes = numberValue(env("DANI_FREE_BODY_LIMIT_BYTES") ?? file.bodyLimitBytes, "bodyLimitBytes", 1_024, 100 * 1024 * 1024) ?? DEFAULTS.bodyLimitBytes;
  const apiKey = env("DANI_FREE_API_KEY") ?? stringValue(file.apiKey, "apiKey");

  const backends = {
    opencode: mergeBackend(file, "opencode"),
    kilo: mergeBackend(file, "kilo"),
    mimo: mergeBackend(file, "mimo"),
  } satisfies Record<BackendId, BackendSettings>;

  const envBackends: Record<BackendId, Partial<BackendSettings>> = {
    opencode: {
      baseUrl: env("DANI_FREE_OPENCODE_BASE_URL"),
      apiKey: env("DANI_FREE_OPENCODE_API_KEY"),
    },
    kilo: {
      baseUrl: env("DANI_FREE_KILO_BASE_URL"),
      apiKey: env("DANI_FREE_KILO_API_KEY"),
    },
    mimo: {
      baseUrl: env("DANI_FREE_MIMO_BASE_URL"),
      apiKey: env("DANI_FREE_MIMO_API_KEY"),
      command: env("DANI_FREE_MIMO_COMMAND"),
    },
  };
  for (const id of ["opencode", "kilo", "mimo"] as const) {
    for (const [key, value] of Object.entries(envBackends[id])) {
      if (value !== undefined) backends[id][key] = value;
    }
  }

  return { host, port, apiKey, requestTimeoutMs, bodyLimitBytes, configPath: selectedPath, backends };
}

export function configDirectory(configPath = DEFAULT_CONFIG_PATH): string {
  return dirname(resolve(configPath));
}
