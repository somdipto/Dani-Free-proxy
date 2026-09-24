import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isUsableFreeRow, KiloAdapter } from "../src/adapters/kilo";
import { ModelCatalog } from "../src/catalog";
import { startRefreshScheduler } from "../src/refresh-scheduler";
import { createRouter } from "../src/router";
import { catalogAdapters, createRouterServer } from "../src/server";
import type { BackendAdapter, BackendModel, ChatRequest } from "../src/types";

function model(id: string, capabilities: BackendModel["capabilities"] = ["text", "tools"]): BackendModel {
  return { backend: "kilo", id, name: `Name ${id}`, capabilities, contextWindow: 100_000, maxTokens: 8_000, healthy: true, source: "discovered" };
}

function okCompletion(text = "ok"): Response {
  return Response.json({ id: "x", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }] });
}

interface FakeKilo extends BackendAdapter {
  models: BackendModel[];
  listFails: boolean;
  calls: string[];
  failing: Set<string>;
}

function fakeKilo(ids: string[]): FakeKilo {
  const fake: FakeKilo = {
    id: "kilo",
    models: ids.map((id) => model(id)),
    listFails: false,
    calls: [],
    failing: new Set(),
    async listModels() {
      if (fake.listFails) throw new Error("gateway down");
      return fake.models;
    },
    async health() { return { backend: "kilo", configured: true, healthy: true, checkedAt: new Date().toISOString() }; },
    async complete(request: ChatRequest) {
      fake.calls.push(request.model);
      if (fake.failing.has(request.model)) return new Response("busy", { status: 503 });
      return okCompletion(`from ${request.model}`);
    },
  };
  return fake;
}

function chat(modelId = "auto"): Request {
  return new Request("http://127.0.0.1/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: modelId, messages: [{ role: "user", content: "hi" }] }),
  });
}

describe("ModelCatalog", () => {
  it("adds new models, marks removed ones, and keeps entries when a backend list fails", async () => {
    const kilo = fakeKilo(["a:free", "b:free"]);
    const catalog = new ModelCatalog();
    let summary = await catalog.refresh([kilo]);
    expect(summary.added).toEqual(["kilo/a:free", "kilo/b:free"]);
    expect(catalog.ranked()).toEqual(["kilo/a:free", "kilo/b:free"]);

    kilo.models = [model("b:free"), model("c:free")];
    summary = await catalog.refresh([kilo]);
    expect(summary.added).toEqual(["kilo/c:free"]);
    expect(summary.removed).toEqual(["kilo/a:free"]);
    expect(catalog.ranked()).toEqual(["kilo/b:free", "kilo/c:free"]);

    const before = catalog.refreshedAt;
    kilo.listFails = true;
    summary = await catalog.refresh([kilo]);
    expect(summary.backendErrors[0].backend).toBe("kilo");
    expect(catalog.ranked()).toEqual(["kilo/b:free", "kilo/c:free"]);
    expect(catalog.refreshedAt).toBe(before);
    expect(catalog.lastRefreshError).toContain("gateway down");
  });

  it("hides a model after 3 consecutive failures and brings it back on success", async () => {
    const catalog = new ModelCatalog();
    await catalog.refresh([fakeKilo(["a:free", "b:free"])]);
    catalog.recordFailure("kilo/a:free", "x");
    catalog.recordFailure("kilo/a:free", "x");
    expect(catalog.ranked()).toEqual(["kilo/b:free", "kilo/a:free"]);
    catalog.recordFailure("kilo/a:free", "x");
    expect(catalog.ranked()).toEqual(["kilo/b:free"]);
    catalog.recordSuccess("kilo/a:free", 100);
    expect(catalog.ranked()).toEqual(["kilo/a:free", "kilo/b:free"]);
  });

  it("flags models that arrive after install as new for 7 days, but not the first-install baseline", async () => {
    let now = new Date("2026-09-25T00:00:00Z");
    const kilo = fakeKilo(["a:free"]);
    const catalog = new ModelCatalog({ now: () => now });
    await catalog.refresh([kilo]);
    expect(catalog.isNew(catalog.get("kilo/a:free")!)).toBe(false);
    now = new Date("2026-09-26T00:00:00Z");
    kilo.models = [model("a:free"), model("b:free")];
    await catalog.refresh([kilo]);
    expect(catalog.isNew(catalog.get("kilo/b:free")!)).toBe(true);
    now = new Date("2026-10-04T00:00:00Z");
    expect(catalog.isNew(catalog.get("kilo/b:free")!)).toBe(false);
  });

  it("puts a rate-limited model on cooldown instead of hiding it", async () => {
    let now = new Date("2026-09-25T00:00:00Z");
    const catalog = new ModelCatalog({ now: () => now });
    await catalog.refresh([fakeKilo(["a:free", "b:free"])]);
    for (let index = 0; index < 5; index += 1) catalog.recordFailure("kilo/a:free", "HTTP 429", { rateLimited: true });
    expect(catalog.ranked()).toEqual(["kilo/b:free", "kilo/a:free"]);
    expect(catalog.get("kilo/a:free")?.consecutiveFailures).toBe(0);
    now = new Date("2026-09-25T00:02:00Z");
    expect(catalog.ranked()).toEqual(["kilo/a:free", "kilo/b:free"]);
  });

  it("probes only models that have never answered", async () => {
    const kilo = fakeKilo(["a:free", "b:free"]);
    const catalog = new ModelCatalog();
    const probed: string[] = [];
    const prober = async (_adapter: BackendAdapter, target: BackendModel) => {
      probed.push(target.id);
      return target.id === "b:free" ? { ok: false, latencyMs: 5, error: "HTTP 503" } : { ok: true, latencyMs: 5 };
    };
    await catalog.refresh([kilo], { prober });
    expect(probed.sort()).toEqual(["a:free", "b:free"]);
    probed.length = 0;
    await catalog.refresh([kilo], { prober });
    expect(probed).toEqual(["b:free"]);
  });

  it("persists to disk with private permissions and reloads", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "dani-cat-")), "nested", "catalog.json");
    const first = new ModelCatalog({ path });
    await first.refresh([fakeKilo(["a:free"])]);
    first.recordSuccess("kilo/a:free", 250);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const reloaded = new ModelCatalog({ path });
    expect(reloaded.get("kilo/a:free")?.latencyMs).toBe(250);
    expect(JSON.parse(readFileSync(path, "utf8")).version).toBe(1);
  });

  it("ignores a corrupt catalog file", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "dani-cat-")), "catalog.json");
    await Bun.write(path, "{not json");
    const catalog = new ModelCatalog({ path });
    expect(catalog.populated).toBe(false);
  });
});

describe("Router with catalog", () => {
  it("serves auto in catalog order, fails over, and records outcomes", async () => {
    const kilo = fakeKilo(["a:free", "b:free"]);
    const catalog = new ModelCatalog();
    const router = createRouter({ adapters: [kilo], catalog, failoverBackoffMs: 0, probeOnRefresh: false });
    await router.refreshCatalog();
    kilo.failing.add("a:free");
    const response = await router.handle(chat());
    expect(response.status).toBe(200);
    expect(response.headers.get("x-dani-free-model")).toBe("kilo/b:free");
    expect(catalog.get("kilo/a:free")?.consecutiveFailures).toBe(1);
    expect(catalog.get("kilo/b:free")?.successes).toBe(1);
  });

  it("stops trying a model that keeps failing", async () => {
    const kilo = fakeKilo(["a:free", "b:free"]);
    const catalog = new ModelCatalog();
    const router = createRouter({ adapters: [kilo], catalog, failoverBackoffMs: 0, probeOnRefresh: false });
    await router.refreshCatalog();
    kilo.failing.add("a:free");
    for (let index = 0; index < 3; index += 1) await router.handle(chat());
    kilo.calls.length = 0;
    await router.handle(chat());
    expect(kilo.calls).toEqual(["b:free"]);
  });

  it("lists auto first as the default, with new flags, and picks up new models after refresh", async () => {
    const kilo = fakeKilo(["a:free"]);
    const router = createRouter({ adapters: [kilo], catalog: new ModelCatalog(), probeOnRefresh: false });
    await router.refreshCatalog();
    let listed = await (await router.handle(new Request("http://127.0.0.1/v1/models"))).json();
    expect(listed.data.map((item: { id: string }) => item.id)).toEqual(["auto", "kilo/a:free"]);
    expect(listed.data[0].default).toBe(true);
    expect(listed.data[1].new).toBe(false);

    kilo.models = [model("a:free"), model("brand-new:free")];
    const refresh = await router.handle(new Request("http://127.0.0.1/v1/models/refresh", { method: "POST" }), "127.0.0.1");
    expect(refresh.status).toBe(200);
    expect((await refresh.json()).added).toEqual(["kilo/brand-new:free"]);
    listed = await (await router.handle(new Request("http://127.0.0.1/v1/models"))).json();
    expect(listed.data.map((item: { id: string }) => item.id)).toEqual(["auto", "kilo/a:free", "kilo/brand-new:free"]);
    expect(listed.data[2].new).toBe(true);
  });

  it("does not hide a model the router sees rate-limited", async () => {
    const kilo = fakeKilo(["a:free", "b:free"]);
    const catalog = new ModelCatalog();
    kilo.complete = async (request: ChatRequest) => {
      kilo.calls.push(request.model);
      if (request.model === "a:free") return new Response("slow down", { status: 429 });
      return okCompletion();
    };
    const router = createRouter({ adapters: [kilo], catalog, failoverBackoffMs: 0, probeOnRefresh: false });
    await router.refreshCatalog();
    for (let index = 0; index < 4; index += 1) await router.handle(chat());
    expect(catalog.get("kilo/a:free")?.consecutiveFailures).toBe(0);
    expect(catalog.ranked()).toContain("kilo/a:free");
  });

  it("lets a user pin a specific model", async () => {
    const kilo = fakeKilo(["a:free", "b:free"]);
    const router = createRouter({ adapters: [kilo], catalog: new ModelCatalog(), probeOnRefresh: false });
    await router.refreshCatalog();
    const response = await router.handle(chat("kilo/b:free"));
    expect(response.headers.get("x-dani-free-model")).toBe("kilo/b:free");
  });

  it("refuses refresh from a non-loopback address", async () => {
    const router = createRouter({ adapters: [fakeKilo(["a:free"])], catalog: new ModelCatalog() });
    const response = await router.handle(new Request("http://x/v1/models/refresh", { method: "POST" }), "192.168.1.9");
    expect(response.status).toBe(403);
    expect(await router.handle(new Request("http://x/v1/models/refresh", { method: "POST" }), "::ffff:127.0.0.1").then((r) => r.status)).toBe(200);
  });

  it("reports catalog state on /health", async () => {
    const router = createRouter({ adapters: [fakeKilo(["a:free"])], catalog: new ModelCatalog(), probeOnRefresh: false });
    await router.refreshCatalog();
    const health = await (await router.handle(new Request("http://x/health"))).json();
    expect(health.catalog.visible).toBe(1);
    expect(typeof health.catalog.refreshedAt).toBe("string");
  });

  it("probes new models with a real tiny completion during refresh", async () => {
    const kilo = fakeKilo(["a:free", "b:free"]);
    kilo.failing.add("b:free");
    const catalog = new ModelCatalog();
    const router = createRouter({ adapters: [kilo], catalog });
    const summary = await router.refreshCatalog();
    expect(summary?.probed.find((item) => item.selector === "kilo/a:free")?.ok).toBe(true);
    expect(summary?.probed.find((item) => item.selector === "kilo/b:free")?.ok).toBe(false);
    expect(catalog.ranked()).toEqual(["kilo/a:free", "kilo/b:free"]);
  });
});

describe("server with catalog", () => {
  it("has no fixed roster and exposes the router over HTTP", async () => {
    const kilo = fakeKilo(["a:free"]);
    const server = createRouterServer({ port: 0, adapters: [kilo], catalog: new ModelCatalog(), probeOnRefresh: false });
    try {
      const refresh = await fetch(`http://127.0.0.1:${server.port}/v1/models/refresh`, { method: "POST" });
      expect(refresh.status).toBe(200);
      const listed = await (await fetch(`http://127.0.0.1:${server.port}/v1/models`)).json();
      expect(listed.data.map((item: { id: string }) => item.id)).toEqual(["auto", "kilo/a:free"]);
    } finally {
      server.close(true);
    }
  });

  it("puts OpenCode first with Kilo as fallback, with a kill switch and private-mode opt-out", () => {
    const saved = { d: process.env.DANI_FREE_DISABLE_OPENCODE, p: process.env.DANI_FREE_PRIVATE_MODE };
    delete process.env.DANI_FREE_DISABLE_OPENCODE;
    delete process.env.DANI_FREE_PRIVATE_MODE;
    expect(catalogAdapters().map((item) => item.id)).toEqual(["opencode", "kilo"]);
    process.env.DANI_FREE_DISABLE_OPENCODE = "1";
    expect(catalogAdapters().map((item) => item.id)).toEqual(["kilo"]);
    delete process.env.DANI_FREE_DISABLE_OPENCODE;
    process.env.DANI_FREE_PRIVATE_MODE = "1";
    expect(catalogAdapters().map((item) => item.id)).toEqual(["kilo"]);
    for (const [key, value] of [["DANI_FREE_DISABLE_OPENCODE", saved.d], ["DANI_FREE_PRIVATE_MODE", saved.p]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
});

describe("Kilo free-model discovery", () => {
  const today = "2026-09-25";
  it("accepts free, unexpired chat models including brand-new ids", () => {
    expect(isUsableFreeRow({ id: "z-ai/glm-5.2:free", isFree: true }, today)).toBe(true);
    expect(isUsableFreeRow({ id: "x/y:free", isFree: true, expiration_date: "2026-09-25" }, today)).toBe(true);
  });
  it("rejects expired, paid, non-chat and pool-router ids", () => {
    expect(isUsableFreeRow({ id: "x/y:free", isFree: true, expiration_date: "2026-09-24" }, today)).toBe(false);
    expect(isUsableFreeRow({ id: "x/paid", isFree: false }, today)).toBe(false);
    expect(isUsableFreeRow({ id: "nvidia/nemotron-3.5-content-safety:free", isFree: true }, today)).toBe(false);
    expect(isUsableFreeRow({ id: "openrouter/free", isFree: true }, today)).toBe(false);
    expect(isUsableFreeRow({ id: "x/img:free", isFree: true, architecture: { output_modalities: ["image"] } }, today)).toBe(false);
  });
  it("lists a new free model from the gateway without a code change, with real capabilities", async () => {
    const payload = {
      data: [
        { id: "z-ai/glm-5.2:free", name: "GLM", isFree: true, context_length: 200000, supported_parameters: ["tools"], architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] }, top_provider: { max_completion_tokens: 32000 } },
        { id: "x/paid", name: "Paid", isFree: false },
      ],
    };
    const adapter = new KiloAdapter({ fetcher: (async () => Response.json(payload)) as unknown as typeof fetch });
    const models = await adapter.listModels();
    expect(models.map((item) => item.id)).toEqual(["z-ai/glm-5.2:free"]);
    expect(models[0].capabilities.sort()).toEqual(["image", "text", "tools"]);
    expect(models[0].maxTokens).toBe(32000);
  });
});

describe("refresh scheduler", () => {
  it("refreshes on boot and then on the interval", async () => {
    let count = 0;
    const scheduler = startRefreshScheduler(async () => { count += 1; return undefined; }, { intervalMs: 20, jitterMs: 0 });
    await scheduler.firstRefresh;
    expect(count).toBe(1);
    await Bun.sleep(70);
    scheduler.stop();
    expect(count).toBeGreaterThanOrEqual(2);
    const settled = count;
    await Bun.sleep(50);
    expect(count).toBe(settled);
  });
  it("survives a failing refresh", async () => {
    const errors: unknown[] = [];
    const scheduler = startRefreshScheduler(async () => { throw new Error("offline"); }, { intervalMs: 1_000_000, onError: (error) => errors.push(error) });
    await scheduler.firstRefresh;
    scheduler.stop();
    expect(errors.length).toBe(1);
  });
});
