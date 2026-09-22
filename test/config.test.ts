import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyBackendEnvironment, loadConfig } from "../src/config";

const ENV_NAMES = [
  "DANI_FREE_CONFIG",
  "DANI_FREE_HOST",
  "DANI_FREE_PORT",
  "DANI_FREE_REQUEST_TIMEOUT_MS",
  "DANI_FREE_ATTEMPT_TIMEOUT_MS",
  "DANI_FREE_BODY_LIMIT_BYTES",
  "DANI_FREE_KILO_BASE_URL",
  "DANI_FREE_KILO_API_KEY",
];

afterEach(() => {
  for (const name of ENV_NAMES) delete process.env[name];
});

function tempFile(contents: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "dani-free-config-test-"));
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(contents));
  return path;
}

const KILO_DEFAULTS = { port: 4290, requestTimeoutMs: 120_000 };

describe("loadConfig listener default overrides", () => {
  it("uses the standard defaults when no overrides are given", () => {
    const config = loadConfig(tempFile({}));
    expect(config.port).toBe(4190);
    expect(config.requestTimeoutMs).toBe(180_000);
  });

  it("uses the listener defaults when no file keys or env vars are set", () => {
    const config = loadConfig(tempFile({}), KILO_DEFAULTS);
    expect(config.port).toBe(4290);
    expect(config.requestTimeoutMs).toBe(120_000);
    expect(config.host).toBe("127.0.0.1");
    expect(config.attemptTimeoutMs).toBe(60_000);
  });

  it("lets the JSON file override the listener defaults", () => {
    const config = loadConfig(tempFile({ port: 5000, requestTimeoutMs: 90_000 }), KILO_DEFAULTS);
    expect(config.port).toBe(5000);
    expect(config.requestTimeoutMs).toBe(90_000);
  });

  it("lets environment variables override both the file and the listener defaults", () => {
    process.env.DANI_FREE_PORT = "5001";
    process.env.DANI_FREE_REQUEST_TIMEOUT_MS = "60000";
    const config = loadConfig(tempFile({ port: 5000, requestTimeoutMs: 90_000 }), KILO_DEFAULTS);
    expect(config.port).toBe(5001);
    expect(config.requestTimeoutMs).toBe(60000);
  });
});

describe("applyBackendEnvironment", () => {
  it("bridges the merged kilo backend settings from the JSON file into the environment", () => {
    const config = loadConfig(
      tempFile({ kilo: { baseUrl: "https://kilo.example", apiKey: "file-key" } }),
      KILO_DEFAULTS,
    );
    applyBackendEnvironment(config);
    expect(process.env.DANI_FREE_KILO_BASE_URL).toBe("https://kilo.example");
    expect(process.env.DANI_FREE_KILO_API_KEY).toBe("file-key");
  });
});
