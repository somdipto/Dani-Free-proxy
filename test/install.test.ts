import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isUsableFreeRow, KiloAdapter } from "../src/adapters/kilo";
import { ModelCatalog } from "../src/catalog";
import { fallbackPorts, listenWithFallback, loadOrCreateInstallKey, readLiveRuntime, removeRuntime, writeRuntime } from "../src/install";
import { createRouter } from "../src/router";

const dir = () => mkdtempSync(join(tmpdir(), "dani-inst-"));

describe("per-install key", () => {
  it("creates a 256-bit key once, mode 600, and reuses it", () => {
    const path = join(dir(), "sub", "api-key");
    const first = loadOrCreateInstallKey(path);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(loadOrCreateInstallKey(path)).toBe(first);
  });
  it("replaces a corrupt key file", async () => {
    const path = join(dir(), "api-key");
    await Bun.write(path, "not-a-key");
    expect(loadOrCreateInstallKey(path)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("port fallback", () => {
  it("tries the preferred port, the next nine, then any port", () => {
    expect(fallbackPorts(4190)).toEqual([4190, 4191, 4192, 4193, 4194, 4195, 4196, 4197, 4198, 4199, 0]);
  });
  it("moves on only when the address is in use", () => {
    const busy = new Set([5000, 5001]);
    const result = listenWithFallback([5000, 5001, 5002], (port) => {
      if (busy.has(port)) throw Object.assign(new Error("Failed to start server. Is port in use?"), { code: "EADDRINUSE" });
      return port;
    });
    expect(result).toEqual({ value: 5002, port: 5002, fellBack: true });
    expect(() => listenWithFallback([5000], () => { throw new Error("permission denied"); })).toThrow("permission denied");
  });
});

describe("runtime record", () => {
  it("is readable while the process lives and removed only by its owner", () => {
    const path = join(dir(), "runtime.json");
    writeRuntime(path, { pid: process.pid, host: "127.0.0.1", port: 4191, baseUrl: "http://127.0.0.1:4191/v1", startedAt: "x", privateMode: false });
    expect(readLiveRuntime(path)?.port).toBe(4191);
    removeRuntime(path, process.pid + 99999);
    expect(existsSync(path)).toBe(true);
    removeRuntime(path);
    expect(existsSync(path)).toBe(false);
  });
  it("ignores a record from a dead process", () => {
    const path = join(dir(), "runtime.json");
    writeRuntime(path, { pid: 2 ** 22 + 12345, host: "h", port: 1, baseUrl: "b", startedAt: "x", privateMode: false });
    expect(readLiveRuntime(path)).toBeUndefined();
  });
});

describe("private mode", () => {
  const today = "2026-09-25";
  it("skips models that may train on prompts, routers and stealth models", () => {
    expect(isUsableFreeRow({ id: "a/b:free", isFree: true, mayTrainOnYourPrompts: true }, today, { privateMode: true })).toBe(false);
    expect(isUsableFreeRow({ id: "a/b:free", isFree: true }, today, { privateMode: true })).toBe(false);
    expect(isUsableFreeRow({ id: "a/b:free", isFree: true, mayTrainOnYourPrompts: false }, today, { privateMode: true })).toBe(true);
    expect(isUsableFreeRow({ id: "kilo-auto/free", isFree: true, mayTrainOnYourPrompts: false }, today, { privateMode: true })).toBe(false);
    expect(isUsableFreeRow({ id: "stealth/x", isFree: true, mayTrainOnYourPrompts: false }, today, { privateMode: true })).toBe(false);
    expect(isUsableFreeRow({ id: "a/b:free", isFree: true, mayTrainOnYourPrompts: true }, today)).toBe(true);
  });
  it("gives a clear 503 when Private mode leaves no models", async () => {
    const payload = { data: [{ id: "a/b:free", name: "B", isFree: true, mayTrainOnYourPrompts: true }] };
    const kilo = new KiloAdapter({ privateMode: true, fetcher: (async () => Response.json(payload)) as unknown as typeof fetch });
    const router = createRouter({ adapters: [kilo], catalog: new ModelCatalog(), privateMode: true, probeOnRefresh: false });
    await router.refreshCatalog();
    const response = await router.handle(new Request("http://x/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] }),
    }));
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error.code).toBe("no_models_available");
    expect(body.error.message).toContain("Private mode");
  });
});

describe("dani-free start (real process)", () => {
  it("requires the install key, falls back when the port is busy, writes runtime and cleans up", async () => {
    const home = dir();
    const blocker = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("busy") });
    const payload = { data: [{ id: "a/b:free", name: "B", isFree: true, mayTrainOnYourPrompts: true }] };
    const gateway = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => new URL(request.url).pathname.endsWith("/models")
        ? Response.json(payload)
        : Response.json({ choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }] }),
    });
    await Bun.write(join(home, "config.json"), "{}");
    const child = Bun.spawn({
      cmd: [process.execPath, "run", join(import.meta.dir, "..", "src", "cli.ts"), "start"],
      env: {
        ...process.env,
        DANI_FREE_CONFIG: join(home, "config.json"),
        DANI_FREE_PORT: String(blocker.port),
        DANI_FREE_KILO_BASE_URL: `http://127.0.0.1:${gateway.port}`,
        DANI_FREE_API_KEY: "",
        DANI_FREE_NO_AUTH: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const reader = child.stdout.getReader();
      let output = "";
      const deadline = Date.now() + 10_000;
      while (!output.includes("DANI_FREE_READY") && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        output += new TextDecoder().decode(value);
      }
      const line = output.split("\n").find((item) => item.startsWith("DANI_FREE_READY "))!;
      const ready = JSON.parse(line.slice("DANI_FREE_READY ".length));
      expect(ready.port).not.toBe(blocker.port);
      expect(ready.baseUrl).toBe(`http://127.0.0.1:${ready.port}/v1`);
      expect(output).not.toContain(readFileSync(ready.apiKeyFile, "utf8").trim());
      const key = readFileSync(ready.apiKeyFile, "utf8").trim();
      expect((await fetch(`${ready.baseUrl}/models`)).status).toBe(401);
      await Bun.sleep(300);
      const listed = await (await fetch(`${ready.baseUrl}/models`, { headers: { authorization: `Bearer ${key}` } })).json();
      expect(listed.data[0].id).toBe("auto");
      const answer = await fetch(`${ready.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] }),
      });
      expect((await answer.json()).choices[0].message.content).toBe("hello");
      const runtime = JSON.parse(readFileSync(join(home, "runtime.json"), "utf8"));
      expect(runtime.port).toBe(ready.port);
      child.kill("SIGTERM");
      await child.exited;
      expect(existsSync(join(home, "runtime.json"))).toBe(false);
    } finally {
      child.kill();
      blocker.stop(true);
      gateway.stop(true);
    }
  }, 20_000);
});

describe("embedding controls", () => {
  it("DANI_FREE_HOME relocates all state without needing a config file, and the parent watchdog exits", async () => {
    const home = join(dir(), "app-data", "proxy");
    const parent = Bun.spawn({ cmd: ["sleep", "30"] });
    const payload = { data: [] };
    const gateway = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json(payload) });
    const child = Bun.spawn({
      cmd: [process.execPath, "run", join(import.meta.dir, "..", "src", "cli.ts"), "start"],
      env: { ...process.env, DANI_FREE_HOME: home, DANI_FREE_CONFIG: "", DANI_FREE_PORT: "0", DANI_FREE_PARENT_PID: String(parent.pid), DANI_FREE_KILO_BASE_URL: `http://127.0.0.1:${gateway.port}` },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const deadline = Date.now() + 10_000;
      while (!existsSync(join(home, "runtime.json")) && Date.now() < deadline) await Bun.sleep(50);
      expect(existsSync(join(home, "api-key"))).toBe(true);
      expect(existsSync(join(home, "runtime.json"))).toBe(true);
      parent.kill();
      await parent.exited;
      const code = await Promise.race([child.exited, Bun.sleep(6_000).then(() => "timeout")]);
      expect(code).toBe(0);
      expect(existsSync(join(home, "runtime.json"))).toBe(false);
    } finally {
      child.kill();
      parent.kill();
      gateway.stop(true);
    }
  }, 20_000);
});
