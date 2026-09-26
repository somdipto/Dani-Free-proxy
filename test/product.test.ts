import { describe, expect, it } from "bun:test";
import { OpenCodeError } from "../src/adapters/opencode";
import { parseToolOutput, toolInstructions } from "../src/adapters/tool-emulation";
import { ModelCatalog } from "../src/catalog";
import { createRouter, scrubUpstreamText } from "../src/router";
import type { BackendAdapter, BackendId, BackendModel, ChatRequest } from "../src/types";

function model(backend: BackendId, id: string): BackendModel {
  return { backend, id, name: `${id} name`, capabilities: ["text", "tools"], contextWindow: 100_000, maxTokens: 8_000, healthy: true, source: "discovered" } as BackendModel;
}

function completion(modelId: string, text = "hi"): Response {
  return Response.json({
    id: `chatcmpl-kilo-1`, object: "chat.completion", created: 1, model: modelId, provider: "SomeProvider",
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
  });
}

function fakeBackend(backend: BackendId, ids: string[], complete: (id: string) => Promise<Response>): BackendAdapter & { calls: string[] } {
  const calls: string[] = [];
  return {
    id: backend,
    calls,
    async listModels() { return ids.map((id) => model(backend, id)); },
    async health() { return { backend, configured: true, healthy: true, checkedAt: new Date().toISOString() }; },
    async complete(request: ChatRequest, m: BackendModel) {
      calls.push(m.id);
      return complete(m.id);
    },
  } as BackendAdapter & { calls: string[] };
}

function chat(body: Partial<ChatRequest> = {}): Request {
  return new Request("http://local/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }], ...body }),
  });
}

function clock(start = Date.parse("2026-09-25T00:00:00Z")) {
  let now = start;
  return { now: () => new Date(now), advance: (ms: number) => { now += ms; } };
}

async function setup(opencodeComplete: (id: string) => Promise<Response>, brand = true) {
  const time = clock();
  const catalog = new ModelCatalog({ now: time.now });
  const opencode = fakeBackend("opencode", ["nemotron-free", "big-pickle"], opencodeComplete);
  const kilo = fakeBackend("kilo", ["nex/pro:free"], async (id) => completion(id, "from fallback"));
  const router = createRouter({
    adapters: [opencode, kilo],
    catalog,
    probeOnRefresh: false,
    failoverBackoffMs: 1,
    ...(brand ? { brand: { id: "dani-free-auto", name: "Dani Free Auto" } } : {}),
  });
  await router.refreshCatalog();
  return { time, catalog, opencode, kilo, router };
}

describe("OpenCode primary, Kilo fallback", () => {
  it("auto uses OpenCode first", async () => {
    const { router, opencode, kilo } = await setup(async (id) => completion(id, "from primary"));
    const response = await router.handle(chat());
    expect((await response.json()).choices[0].message.content).toBe("from primary");
    expect(opencode.calls).toEqual(["nemotron-free"]);
    expect(kilo.calls).toEqual([]);
  });

  it("keeps OpenCode first when Kilo succeeded earlier but OpenCode is still usable", async () => {
    const { router, opencode, kilo, catalog } = await setup(async (id) => completion(id, "from primary"));
    catalog.recordSuccess("kilo/nex/pro:free", 50);
    expect(catalog.ranked(["opencode", "kilo"])[0]).toBe("opencode/nemotron-free");
    const response = await router.handle(chat());
    expect((await response.json()).choices[0].message.content).toBe("from primary");
    expect(opencode.calls).toEqual(["nemotron-free"]);
    expect(kilo.calls).toEqual([]);
  });

  it("switches the whole OpenCode backend to Kilo when its free quota runs out, then switches back after a recovery probe", async () => {
    let quotaGone = true;
    const { router, opencode, kilo, catalog, time } = await setup(async (id) => {
      if (quotaGone) throw new OpenCodeError("OpenCode turn failed: free usage limit reached", { status: 429, code: "quota_exhausted" });
      return completion(id, "from primary");
    });
    const first = await router.handle(chat());
    expect((await first.json()).choices[0].message.content).toBe("from fallback");
    // The first quota answer holds the whole backend: big-pickle is not tried.
    expect(opencode.calls).toEqual(["nemotron-free"]);
    expect(catalog.exhaustedBackends()).toEqual(["opencode"]);

    const second = await router.handle(chat());
    expect((await second.json()).choices[0].message.content).toBe("from fallback");
    expect(opencode.calls).toEqual(["nemotron-free"]);
    expect(kilo.calls.length).toBe(2);

    // Not due yet: no probe.
    expect(await router.probeRecovery()).toEqual([]);
    time.advance(31 * 60_000);
    quotaGone = false;
    expect(await router.probeRecovery()).toEqual(["opencode"]);
    expect(catalog.exhaustedBackends()).toEqual([]);
    const third = await router.handle(chat());
    expect((await third.json()).choices[0].message.content).toBe("from primary");
  });

  it("a still-empty quota on the recovery probe extends the hold with a longer backoff", async () => {
    const { router, catalog, time } = await setup(async () => {
      throw new OpenCodeError("rate limited", { status: 429 });
    });
    await (await router.handle(chat())).text();
    const firstUntil = Date.parse(catalog.backendQuota("opencode")!.until);
    time.advance(31 * 60_000);
    expect(await router.probeRecovery()).toEqual([]);
    const quota = catalog.backendQuota("opencode")!;
    expect(quota.hits).toBe(2);
    expect(Date.parse(quota.until) - firstUntil).toBeGreaterThan(55 * 60_000);
  });

  it("honors Retry-After for the hold", async () => {
    const { router, catalog, time } = await setup(async () => {
      throw new OpenCodeError("quota", { status: 429, retryAfterMs: 3 * 60 * 60_000 });
    });
    await (await router.handle(chat())).text();
    expect(Date.parse(catalog.backendQuota("opencode")!.until) - time.now().getTime()).toBe(3 * 60 * 60_000);
  });

  it("a FreeTierError 403 from OpenCode falls over to Kilo instead of failing the request", async () => {
    const { router } = await setup(async () => {
      throw new OpenCodeError("OpenCode turn failed: free tier can only be used from within OpenCode", { status: 403, code: "free_tier_rejected" });
    });
    const response = await router.handle(chat());
    expect(response.status).toBe(200);
    expect((await response.json()).choices[0].message.content).toBe("from fallback");
  });

  it("a pinned model on a held backend goes straight to the next best free model", async () => {
    const { router, opencode, catalog } = await setup(async (id) => completion(id), false);
    catalog.recordBackendQuota("opencode", "quota");
    const response = await router.handle(chat({ model: "opencode/big-pickle" }));
    expect((await response.json()).choices[0].message.content).toBe("from fallback");
    expect(opencode.calls).toEqual([]);
  });
});

describe("Dani Free Auto branding", () => {
  it("lists only Dani Free Auto", async () => {
    const { router } = await setup(async (id) => completion(id));
    const listed = await (await router.handle(new Request("http://local/v1/models"))).json();
    expect(listed.data.map((item: { id: string; name: string }) => [item.id, item.name])).toEqual([["dani-free-auto", "Dani Free Auto"]]);
    expect(JSON.stringify(listed)).not.toMatch(/opencode|kilo|nemotron|pickle|nex/i);
  });

  it("answers as dani-free-auto with no model header, provider field or backend names", async () => {
    const { router } = await setup(async (id) => completion(id, "from primary"));
    const response = await router.handle(chat({ model: "dani-free-auto" }));
    expect(response.headers.get("x-dani-free-model")).toBeNull();
    const text = await response.text();
    const body = JSON.parse(text);
    expect(body.model).toBe("dani-free-auto");
    expect(text).not.toMatch(/opencode|kilo|nemotron|SomeProvider/i);
  });

  it("rewrites the model in every SSE frame", async () => {
    const sse = [
      `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", model: "nemotron-free", choices: [{ index: 0, delta: { content: "a" } }] })}`,
      `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", model: "nemotron-free", provider: "P", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}`,
      "data: [DONE]",
      "",
    ].join("\n\n");
    const { router } = await setup(async () => new Response(sse, { headers: { "content-type": "text/event-stream" } }));
    const text = await (await router.handle(chat({ stream: true }))).text();
    expect(text).not.toContain("nemotron");
    expect(text).not.toContain('"provider"');
    expect(text.match(/"model":"dani-free-auto"/g)?.length).toBe(2);
    expect(text).toContain("data: [DONE]");
  });

  it("an unknown model name is treated as auto, and total failure never names a model", async () => {
    const time = clock();
    const catalog = new ModelCatalog({ now: time.now });
    const failing = fakeBackend("kilo", ["nex/pro:free"], async () => { throw new OpenCodeError("kilo nex/pro:free exploded", { status: 500 }); });
    const router = createRouter({ adapters: [failing], catalog, probeOnRefresh: false, failoverBackoffMs: 1, brand: { id: "dani-free-auto", name: "Dani Free Auto" } });
    await router.refreshCatalog();
    const response = await router.handle(chat({ model: "gpt-4o" }));
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).toContain("Dani Free Auto");
    expect(text).not.toMatch(/kilo|nex/i);
  });

  it("/health does not list backends", async () => {
    const { router } = await setup(async (id) => completion(id));
    const health = await (await router.handle(new Request("http://local/health"))).json();
    expect(health.backends).toBeUndefined();
    expect(health.model).toEqual({ id: "dani-free-auto", name: "Dani Free Auto", available: true });
    expect(JSON.stringify(health)).not.toMatch(/opencode|kilo/i);
  });

  it("scrubs backend names and model ids from passthrough messages", () => {
    expect(scrubUpstreamText("OpenCode Zen said nemotron-free is over context", ["nemotron-free"])).toBe("upstream said model is over context");
  });
});

describe("text tool protocol", () => {
  const tools = [{ type: "function", function: { name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } } }];
  const request = { model: "x", messages: [], tools } as unknown as ChatRequest;

  it("describes the host tools and switches off the built-in ones", () => {
    const text = toolInstructions(request);
    expect(text).toContain("## read_file");
    expect(text).toContain("<tool_call>");
    expect(text).toContain("switched off");
    expect(toolInstructions({ ...request, tool_choice: "none" })).toBe("");
  });

  it("parses tagged calls into OpenAI tool_calls and keeps leading text", () => {
    const parsed = parseToolOutput('Let me look.\n<tool_call>{"name": "read_file", "arguments": {"path": "a.ts"}}</tool_call>', request);
    expect(parsed.content).toBe("Let me look.");
    expect(parsed.toolCalls.map((call) => [call.function.name, JSON.parse(call.function.arguments)])).toEqual([["read_file", { path: "a.ts" }]]);
  });

  it("ignores calls to tools the request did not offer", () => {
    const parsed = parseToolOutput('<tool_call>{"name": "bash", "arguments": {"cmd": "rm -rf /"}}</tool_call>', request);
    expect(parsed.toolCalls).toEqual([]);
  });

  it("accepts a fenced JSON call as a fallback", () => {
    const parsed = parseToolOutput('```json\n{"name": "read_file", "arguments": {"path": "b"}}\n```', request);
    expect(parsed.toolCalls.length).toBe(1);
  });
});

describe("catalog selectors", () => {
  it("does not double-prefix ids that already carry their backend (OpenCode)", async () => {
    const catalog = new ModelCatalog();
    const opencode = fakeBackend("opencode", ["opencode/big-pickle"], async (id) => completion(id));
    await catalog.refresh([opencode]);
    expect(catalog.ranked()).toEqual(["opencode/big-pickle"]);
  });
});

describe("first run", () => {
  it("ranks models that have answered ahead of never-answered ones", async () => {
    const catalog = new ModelCatalog();
    const kilo = fakeBackend("kilo", ["a:free", "b:free"], async (id) => completion(id));
    await catalog.refresh([kilo]);
    expect(catalog.ranked()).toEqual(["kilo/a:free", "kilo/b:free"]);
    catalog.recordSuccess("kilo/b:free", 100);
    expect(catalog.ranked()).toEqual(["kilo/b:free", "kilo/a:free"]);
  });

  it("a streaming attempt with no first byte moves to the next model", async () => {
    const catalog = new ModelCatalog();
    const hung = fakeBackend("kilo", ["hung:free", "fast:free"], (id) => id === "hung:free"
      ? new Promise<Response>(() => undefined)
      : Promise.resolve(new Response(`data: ${JSON.stringify({ id: "x", model: id, choices: [{ index: 0, delta: { content: "hi" } }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })));
    const router = createRouter({ adapters: [hung], catalog, probeOnRefresh: false, attemptTimeoutMs: 150, brand: { id: "dani-free-auto", name: "Dani Free Auto" } });
    await router.refreshCatalog();
    const text = await (await router.handle(chat({ stream: true }))).text();
    expect(text).toContain('"content":"hi"');
    expect(hung.calls).toEqual(["hung:free", "fast:free"]);
  });
});

import { FeedbackStore, modelTier, orderForTask, parseTask } from "../src/tasks";

describe("task routing", () => {
  it("parses the task header: missing = none, unknown = reason", () => {
    expect(parseTask(null)).toBeUndefined();
    expect(parseTask("ack")).toBe("ack");
    expect(parseTask("TITLE")).toBe("title");
    expect(parseTask("something-new")).toBe("reason");
  });

  it("tiers models by size and name", () => {
    const tier = (id: string, contextWindow = 200_000) => modelTier({ id, contextWindow });
    expect(tier("liquid/lfm-2.5-2.6b:free", 65_536)).toBe("light");
    expect(tier("qwen/qwen3.8-27b:free")).toBe("ok");
    expect(tier("nvidia/nemotron-3-super-120b-a12b:free")).toBe("strong");
    expect(tier("nex-agi/nex-n2.5-mini:free")).toBe("light");
    expect(tier("nex-agi/nex-n2.5-pro:free")).toBe("strong");
    expect(tier("z-ai/glm-5.2:free", 32_768)).toBe("light");
    expect(tier("big-pickle")).toBe("ok");
  });

  it("reason keeps light models last; title puts them first; ack drops the sidecar and sorts by speed", () => {
    const routes = [
      { model: model("kilo", "tiny-2b:free"), latencyMs: 300 },
      { model: model("opencode", "opencode/big-pickle"), latencyMs: 100 },
      { model: model("kilo", "big-120b:free"), latencyMs: 900 },
    ];
    expect(orderForTask("reason", routes).map((r) => r.model.id)).toEqual(["opencode/big-pickle", "big-120b:free", "tiny-2b:free"]);
    expect(orderForTask("title", routes).map((r) => r.model.id)).toEqual(["tiny-2b:free", "big-120b:free", "opencode/big-pickle"]);
    expect(orderForTask("summary", routes).at(-1)!.model.id).toBe("opencode/big-pickle");
    expect(orderForTask("ack", routes).map((r) => r.model.id)).toEqual(["tiny-2b:free", "big-120b:free"]);
    expect(orderForTask("tool_repair", routes)[0].model.id).toBe("big-120b:free");
  });

  it("feedback moves a model at most 30% of the list and only after 20 events", () => {
    const store = new FeedbackStore({ minEvents: 20 });
    const ids = Array.from({ length: 10 }, (_, i) => `m${i}`);
    for (let i = 0; i < 25; i++) {
      store.track(`req-bad-${i}0000`, "m0", "reason");
      store.record(`req-bad-${i}0000`, "bad_tool_json");
      store.track(`req-ok-${i}00000`, "m5", "reason");
      store.record(`req-ok-${i}00000`, "ok");
    }
    const out = store.adjust("reason", ids.map((id) => ({ model: model("kilo", id) })), (r) => r.model.id).map((r) => r.model.id);
    expect(out.indexOf("m0")).toBe(3);
    expect(out.length).toBe(10);
    expect(store.adjust("chat", ids.map((id) => ({ model: model("kilo", id) })), (r) => r.model.id).map((r) => r.model.id)).toEqual(ids);
  });

  it("feedback is idempotent and drops unknown request ids", () => {
    const store = new FeedbackStore({ minEvents: 1 });
    store.track("abcdefgh1", "m", "chat");
    expect(store.record("abcdefgh1", "ok")).toBe("recorded");
    expect(store.record("abcdefgh1", "ok")).toBe("duplicate");
    expect(store.record("zzzzzzzz9", "ok")).toBe("unknown_request");
    expect(store.badRate("chat", "m")).toBe(0);
  });
});

describe("api v1 endpoints", () => {
  async function brandRouter(kiloComplete: (id: string) => Promise<Response>, extra: Record<string, unknown> = {}) {
    const catalog = new ModelCatalog();
    const kilo = fakeBackend("kilo", ["slow:free", "fast:free", "third:free"], kiloComplete);
    const router = createRouter({ adapters: [kilo], catalog, probeOnRefresh: false, failoverBackoffMs: 1, brand: { id: "dani-free-auto", name: "Dani Free Auto" }, ...extra });
    await router.refreshCatalog();
    return { router, kilo, catalog };
  }
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    new Request(`http://local${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  it("/health reports api 1 and the task list", async () => {
    const { router } = await brandRouter(async (id) => completion(id));
    const health = await (await router.handle(new Request("http://local/health"))).json();
    expect(health.api).toBe(1);
    expect(health.tasks).toEqual(["ack", "reason", "tool_plan", "tool_repair", "summary", "chat", "title"]);
  });

  it("returns a request id and accepts feedback for it, once", async () => {
    const { router } = await brandRouter(async (id) => completion(id));
    const response = await router.handle(chat());
    const id = response.headers.get("x-dani-request-id")!;
    expect(id).toMatch(/^[a-f0-9]{32}$/);
    const first = await router.handle(post("/v1/feedback", { v: 1, request_id: id, task: "chat", outcome: "ok" }), "127.0.0.1");
    expect(first.status).toBe(200);
    expect((await router.handle(post("/v1/feedback", { v: 1, request_id: id, outcome: "ok" }), "127.0.0.1")).status).toBe(200);
    expect((await router.handle(post("/v1/feedback", { v: 1, request_id: id, outcome: "great" }), "127.0.0.1")).status).toBe(400);
    expect((await router.handle(post("/v1/feedback", { v: 1, request_id: id, outcome: "ok" }), "10.0.0.2")).status).toBe(403);
  });

  it("feedback is off in Private mode", async () => {
    const { router } = await brandRouter(async (id) => completion(id), { privateMode: true });
    expect((await router.handle(post("/v1/feedback", { v: 1, request_id: "abcdefgh12", outcome: "ok" }), "127.0.0.1")).status).toBe(204);
  });

  it("ack rejects tools and caps output", async () => {
    let seenMax = 0;
    const { router } = await brandRouter(async (id) => completion(id));
    const refused = await router.handle(chat({ tools: [{ type: "function", function: { name: "x" } }] } as Partial<ChatRequest>));
    expect(refused.status).toBe(200); // no task header: normal auto
    const withTask = new Request("http://local/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json", "x-dani-task": "ack" },
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }], tools: [{ type: "function", function: { name: "x" } }] }),
    });
    const rejected = await router.handle(withTask);
    expect(rejected.status).toBe(400);
    expect((await rejected.json()).error.code).toBe("tools_not_allowed");
    void seenMax;
  });

  it("ack hedges two routes, first byte wins, loser is cancelled and not marked failed", async () => {
    let slowAborted = false;
    const { router, catalog } = await brandRouter(async (id) => {
      if (id === "slow:free") {
        return new Response(new ReadableStream({ cancel() { slowAborted = true; } }), { headers: { "content-type": "text/event-stream" } });
      }
      return new Response(`data: ${JSON.stringify({ id: "x", model: id, choices: [{ index: 0, delta: { content: "On it" } }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    });
    const request = new Request("http://local/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json", "x-dani-task": "ack" },
      body: JSON.stringify({ model: "auto", stream: true, messages: [{ role: "user", content: "book a table" }] }),
    });
    const response = await router.handle(request);
    const text = await response.text();
    expect(text).toContain("On it");
    expect(text).toContain('"model":"dani-free-auto"');
    await Bun.sleep(10);
    expect(slowAborted).toBe(true);
    expect(catalog.get("kilo/slow:free")!.failures).toBe(0);
  });

  it("ack times out with 504 ack_timeout", async () => {
    const { router } = await brandRouter(() => new Promise<Response>(() => undefined), { ackTimeoutMs: 100 });
    const request = new Request("http://local/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json", "x-dani-task": "ack" },
      body: JSON.stringify({ model: "auto", stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
    const started = Date.now();
    const response = await router.handle(request);
    expect(response.status).toBe(504);
    expect((await response.json()).error.code).toBe("ack_timeout");
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("warm answers 204 at once", async () => {
    const { router } = await brandRouter(async (id) => completion(id));
    expect((await router.handle(post("/v1/warm", { task: "ack" }))).status).toBe(204);
  });
});

import { IDENTITY_PROMPT, opaqueToolCallId, seal, sealKey, unseal, withIdentity, devExposureAllowed } from "../src/opacity";

describe("model identity opacity", () => {
  it("adds the Dani Free identity line to every branded request, appended to the app's system prompt", async () => {
    const seen: ChatRequest[] = [];
    const time = clock();
    const catalog = new ModelCatalog({ now: time.now });
    const kilo = fakeBackend("kilo", ["nex/pro:free"], async (id) => completion(id));
    const original = kilo.complete.bind(kilo);
    kilo.complete = async (request: ChatRequest, m: BackendModel, signal?: AbortSignal) => { seen.push(request); return original(request, m, signal as AbortSignal); };
    const router = createRouter({ adapters: [kilo], catalog, probeOnRefresh: false, brand: { id: "dani-free-auto", name: "Dani Free Auto" } });
    await router.refreshCatalog();
    await router.handle(chat({ messages: [{ role: "system", content: "You are Dani." }, { role: "user", content: "which model are you?" }] }));
    expect(seen[0].messages[0].content).toBe(`You are Dani.\n\n${IDENTITY_PROMPT}`);
    expect(IDENTITY_PROMPT).toContain("Dani Free");
    await router.handle(chat());
    expect(seen[1].messages[0]).toEqual({ role: "system", content: IDENTITY_PROMPT });
  });

  it("keeps array system content and does not touch dev mode", async () => {
    const request = withIdentity({ model: "auto", messages: [{ role: "system", content: [{ type: "text", text: "A" }] as never }, { role: "user", content: "hi" }] });
    expect((request.messages[0].content as unknown as unknown[]).length).toBe(2);
    const { router, kilo } = await setup(async () => { throw new OpenCodeError("down", { status: 500 }); }, false);
    const calls: ChatRequest[] = [];
    const original = kilo.complete.bind(kilo);
    kilo.complete = async (r: ChatRequest, m: BackendModel, s?: AbortSignal) => { calls.push(r); return original(r, m, s as AbortSignal); };
    await router.handle(chat());
    expect(JSON.stringify(calls)).not.toContain("Dani Free");
  });

  it("drops provider extras and rewrites tool-call ids so nothing hints at the model family", async () => {
    const { router } = await setup(async () => Response.json({
      id: "gen-123", object: "chat.completion", created: 1, model: "nemotron-free", provider: "Nvidia", system_fingerprint: "fp_x",
      choices: [{
        index: 0, finish_reason: "tool_calls", native_finish_reason: "tool_use", logprobs: { content: [{ token: "Ġhi" }] },
        message: { role: "assistant", content: null, reasoning_details: [{ format: "anthropic-claude-v1", text: "t" }],
          tool_calls: [{ id: "toolu_01ABC", type: "function", function: { name: "f", arguments: "{}" } }] },
      }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, cost: 0, prompt_tokens_details: { cached_tokens: 0 } },
    }));
    const text = await (await router.handle(chat())).text();
    expect(text).not.toMatch(/nemotron|nvidia|toolu_|fp_x|anthropic|claude|logprobs|native_finish|reasoning_details|cost|Ġ/i);
    const body = JSON.parse(text);
    expect(body.choices[0].message.tool_calls[0].id).toBe(opaqueToolCallId("toolu_01ABC"));
    expect(body.choices[0].message.tool_calls[0].id).toMatch(/^call_d[0-9a-f]{23}$/);
    expect(body.usage).toEqual({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
    expect(opaqueToolCallId(body.choices[0].message.tool_calls[0].id)).toBe(body.choices[0].message.tool_calls[0].id);
  });

  it("scrubs model makers, ids and version strings from error text", () => {
    expect(scrubUpstreamText("qwen/qwen3-coder:free is rate limited, retry after 30s (HTTP 429)")).toBe("model is rate limited, retry after 30s (HTTP 429)");
    expect(scrubUpstreamText("Anthropic claude-3.5 said no")).toBe("model said no");
    expect(scrubUpstreamText("Model cohere/north-mini-code returned 503", ["kilo/cohere/north-mini-code"])).toBe("model returned 503");
  });

  it("says Dani Free Auto, not a model id, when max_tokens is too high", async () => {
    const { router } = await setup(async (id) => completion(id));
    const text = await (await router.handle(chat({ max_tokens: 999_999 }))).text();
    expect(text).toContain("Dani Free Auto");
    expect(text).not.toMatch(/nemotron|pickle|nex/i);
  });

  it("seals state files so model ids are not readable on disk", () => {
    const key = sealKey("install-key");
    const sealed = seal('{"entries":{"kilo/nex/pro:free":{}}}', key);
    expect(sealed).not.toContain("nex");
    expect(unseal(sealed, key)).toBe('{"entries":{"kilo/nex/pro:free":{}}}');
    expect(unseal('{"plain":true}', key)).toBe('{"plain":true}');
    expect(() => unseal(sealed, sealKey("other"))).toThrow();
  });

  it("the development roster needs a non-release build", () => {
    expect(devExposureAllowed({ DANI_FREE_EXPOSE_MODELS: "1" })).toBe(process.env.DANI_FREE_RELEASE !== "1");
    expect(devExposureAllowed({})).toBe(false);
  });
});

describe("automatic model updates", () => {
  it("keeps a model that appeared after install out of routing until it passes the smoke check", async () => {
    const catalog = new ModelCatalog();
    const kilo = fakeBackend("kilo", ["old:free"], async (id) => completion(id));
    let probeOk = false;
    await catalog.refresh([kilo]);
    (kilo as { listModels: () => Promise<BackendModel[]> }).listModels = async () => [model("kilo", "old:free"), model("kilo", "new:free")];
    await catalog.refresh([kilo], { prober: async () => ({ ok: probeOk, latencyMs: 10, error: probeOk ? undefined : "HTTP 500" }) });
    expect(catalog.ranked()).toEqual(["kilo/old:free"]);
    probeOk = true;
    await catalog.refresh([kilo], { prober: async () => ({ ok: probeOk, latencyMs: 10 }) });
    expect(catalog.ranked()).toContain("kilo/new:free");
  });

  it("drains a removed model and still serves if only unproven models are left", async () => {
    const catalog = new ModelCatalog();
    const kilo = fakeBackend("kilo", ["gone:free"], async (id) => completion(id));
    await catalog.refresh([kilo]);
    (kilo as { listModels: () => Promise<BackendModel[]> }).listModels = async () => [model("kilo", "fresh:free")];
    await catalog.refresh([kilo]);
    expect(catalog.ranked()).toEqual(["kilo/fresh:free"]);
  });

  it("keeps a model that fails the tool-call smoke check off tool turns", async () => {
    const catalog = new ModelCatalog();
    const good = fakeBackend("kilo", ["good:free"], async (id) => completion(id));
    await catalog.refresh([good]);
    (good as { listModels: () => Promise<BackendModel[]> }).listModels = async () => [model("kilo", "good:free"), model("kilo", "badtools:free")];
    await catalog.refresh([good], { prober: async (_a, m) => ({ ok: true, latencyMs: 5, toolsOk: m.id !== "badtools:free" }) });
    expect(catalog.toolsBroken("kilo/badtools:free")).toBe(true);
    const router = createRouter({ adapters: [good], catalog, probeOnRefresh: false, failoverBackoffMs: 1 });
    good.calls.length = 0;
    await router.handle(chat({ model: "kilo/badtools:free", tools: [{ type: "function", function: { name: "f", parameters: { type: "object" } } }] } as Partial<ChatRequest>));
    expect(good.calls).not.toContain("badtools:free");
  });

  it("the router's smoke check forces one tool call and grades the JSON", async () => {
    const catalog = new ModelCatalog();
    const kilo = fakeBackend("kilo", ["seed:free"], async (id) => completion(id));
    await catalog.refresh([kilo]);
    const replies: Record<string, (request: ChatRequest) => Response> = {
      "t-good:free": (request) => request.tools
        ? Response.json({ id: "1", object: "chat.completion", created: 1, model: "x", choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "get_weather", arguments: "{\"city\":\"Paris\"}" } }] } }] })
        : completion("x", "ok"),
      "t-bad:free": (request) => request.tools ? completion("x", "It is sunny.") : completion("x", "ok"),
    };
    (kilo as { listModels: () => Promise<BackendModel[]> }).listModels = async () => [model("kilo", "seed:free"), model("kilo", "t-good:free"), model("kilo", "t-bad:free")];
    kilo.complete = async (request: ChatRequest, m: BackendModel) => (replies[m.id] ?? (() => completion(m.id)))(request);
    const router = createRouter({ adapters: [kilo], catalog, probeOnRefresh: true });
    await router.refreshCatalog();
    expect(catalog.toolsBroken("kilo/t-good:free")).toBe(false);
    expect(catalog.toolsBroken("kilo/t-bad:free")).toBe(true);
    expect(catalog.ranked()).toEqual(expect.arrayContaining(["kilo/t-good:free", "kilo/t-bad:free"]));
  });
});

import { mkdtempSync, readFileSync as readFs, existsSync as exists, writeFileSync as writeFs, mkdirSync as mkdirFs } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { createHash } from "node:crypto";
import { OpenCodeSidecar, OPENCODE_VERSION, OPENCODE_ASSETS, platformKey, newerVersion } from "../src/opencode-sidecar";

describe("engine auto-update", () => {
  const key = platformKey()!;
  const asset = OPENCODE_ASSETS[key];
  const release = (version: string, publishedAgoMs: number, digest: string) => Response.json({
    tag_name: `v${version}`, draft: false, prerelease: false, published_at: new Date(Date.now() - publishedAgoMs).toISOString(),
    assets: [{ name: asset.name, digest: `sha256:${digest}`, browser_download_url: `https://github.com/anomalyco/opencode/releases/download/v${version}/${asset.name}` }],
  });

  it("compares versions numerically", () => {
    expect(newerVersion("1.18.40", "1.18.32")).toBe(true);
    expect(newerVersion("1.19.0", "1.18.32")).toBe(true);
    expect(newerVersion("1.18.32", "1.18.32")).toBe(false);
    expect(newerVersion("1.9.99", "1.18.32")).toBe(false);
  });

  it("stays on the current engine when the latest release is not newer, or is under 48h old", async () => {
    const home = mkdtempSync(joinPath(tmpdir(), "dfeng-"));
    let body = () => release(OPENCODE_VERSION, 3 * 86_400_000, "0".repeat(64));
    const sidecar = new OpenCodeSidecar({ home, fetch: (async () => body()) as unknown as typeof fetch });
    expect((await sidecar.checkForUpdate()).status).toBe("current");
    body = () => release("99.0.0", 60 * 60_000, "0".repeat(64));
    expect((await sidecar.checkForUpdate()).status).toBe("too_new");
  });

  it("rejects a download whose SHA-256 does not match GitHub's digest, and never retries it", async () => {
    const home = mkdtempSync(joinPath(tmpdir(), "dfeng-"));
    let downloads = 0;
    const fetchFn = (async (url: string) => {
      if (url.includes("api.github.com")) return release("99.0.0", 3 * 86_400_000, "a".repeat(64));
      downloads += 1;
      return new Response(new Uint8Array([1, 2, 3]));
    }) as unknown as typeof fetch;
    const sidecar = new OpenCodeSidecar({ home, fetch: fetchFn });
    const first = await sidecar.checkForUpdate();
    expect(first.status).toBe("rejected");
    expect(sidecar.activeVersion).toBe(OPENCODE_VERSION);
    expect((await sidecar.checkForUpdate()).status).toBe("rejected");
    expect(downloads).toBe(1);
    expect(JSON.parse(readFs(joinPath(home, "engine", "engine.json"), "utf8")).rejected).toEqual(["99.0.0"]);
  });

  it("ignores assets hosted anywhere but the release's own GitHub download path", async () => {
    const home = mkdtempSync(joinPath(tmpdir(), "dfeng-"));
    const fetchFn = (async () => Response.json({
      tag_name: "v99.0.0", draft: false, prerelease: false, published_at: new Date(Date.now() - 3 * 86_400_000).toISOString(),
      assets: [{ name: asset.name, digest: `sha256:${"b".repeat(64)}`, browser_download_url: `https://evil.example/${asset.name}` }],
    })) as unknown as typeof fetch;
    expect((await new OpenCodeSidecar({ home, fetch: fetchFn }).checkForUpdate()).status).toBe("no_asset");
  });

  it("installs a signed-app seed atomically without making any network request", async () => {
    const home = mkdtempSync(joinPath(tmpdir(), "dfseed-"));
    const source = joinPath(home, "seed");
    writeFs(source, "engine-bytes");
    const digest = createHash("sha256").update("engine-bytes").digest("hex");
    let requests = 0;
    const sidecar = new OpenCodeSidecar({ home, seedBinary: source, seedSha256: digest, noInstall: true,
      fetch: (async () => { requests++; throw new Error("network forbidden"); }) as unknown as typeof fetch });
    const target = await sidecar.ensureBinary();
    expect(readFs(target, "utf8")).toBe("engine-bytes");
    expect(target).toBe(sidecar.binaryFor(OPENCODE_VERSION));
    expect(requests).toBe(0);
    expect(await sidecar.ensureBinary()).toBe(target);
    expect(exists(joinPath(home, "engine", "bin", OPENCODE_VERSION, "dani-engine.tmp"))).toBe(false);
  });

  it("refuses a wrong digest or changed seed, preserving the existing engine", async () => {
    const home = mkdtempSync(joinPath(tmpdir(), "dfseed-"));
    const source = joinPath(home, "seed");
    writeFs(source, "engine-bytes");
    const digest = createHash("sha256").update("engine-bytes").digest("hex");
    const sidecar = new OpenCodeSidecar({ home, seedBinary: source, seedSha256: digest, noInstall: true });
    const target = await sidecar.ensureBinary();
    writeFs(source, "mutated");
    expect(await sidecar.ensureBinary()).toBe(target);
    expect(readFs(target, "utf8")).toBe("engine-bytes");
    const bad = new OpenCodeSidecar({ home: mkdtempSync(joinPath(tmpdir(), "dfseed-")), seedBinary: source, seedSha256: digest, noInstall: true });
    expect(bad.ensureBinary()).rejects.toThrow("checksum");
    expect(exists(bad.binaryFor(OPENCODE_VERSION))).toBe(false);
    const noPath = new OpenCodeSidecar({ home: mkdtempSync(joinPath(tmpdir(), "dfseed-")), seedSha256: digest, noInstall: true });
    expect(noPath.ensureBinary()).rejects.toThrow("needs a binary");
  });

  it("keeps a newer known-good engine when the app seed is missing", async () => {
    const home = mkdtempSync(joinPath(tmpdir(), "dfseed-"));
    const sidecar = new OpenCodeSidecar({ home, seedBinary: joinPath(home, "absent"), seedSha256: "0".repeat(64), noInstall: true });
    const newer = "99.0.0";
    mkdirFs(joinPath(home, "engine", "bin", newer), { recursive: true });
    writeFs(sidecar.binaryFor(newer), "working");
    writeFs(joinPath(home, "engine", "engine.json"), JSON.stringify({ version: newer }));
    expect(await sidecar.ensureBinary()).toBe(sidecar.binaryFor(newer));
  });

  it("disables release GitHub engine checks unless explicitly enabled", async () => {
    const oldRelease = process.env.DANI_FREE_RELEASE;
    const oldUpdate = process.env.DANI_FREE_ENGINE_AUTOUPDATE;
    process.env.DANI_FREE_RELEASE = "1";
    delete process.env.DANI_FREE_ENGINE_AUTOUPDATE;
    try {
      const sidecar = new OpenCodeSidecar({ home: mkdtempSync(joinPath(tmpdir(), "dfseed-")), fetch: (async () => { throw new Error("unexpected network request"); }) as unknown as typeof fetch });
      expect((await sidecar.checkForUpdate()).status).toBe("disabled");
    } finally {
      if (oldRelease === undefined) delete process.env.DANI_FREE_RELEASE; else process.env.DANI_FREE_RELEASE = oldRelease;
      if (oldUpdate === undefined) delete process.env.DANI_FREE_ENGINE_AUTOUPDATE; else process.env.DANI_FREE_ENGINE_AUTOUPDATE = oldUpdate;
    }
  });

  it("moves an old install to neutral names and keeps session data out of the install folder", () => {
    const home = mkdtempSync(joinPath(tmpdir(), "dfeng-"));
    const exe = process.platform === "win32" ? "opencode.exe" : "opencode";
    mkdirFs(joinPath(home, "opencode", "bin", OPENCODE_VERSION), { recursive: true });
    mkdirFs(joinPath(home, "opencode", "data", "opencode", "log"), { recursive: true });
    writeFs(joinPath(home, "opencode", "bin", OPENCODE_VERSION, exe), "bin");
    writeFs(joinPath(home, "opencode", "data", "opencode", "log", "opencode.log"), "modelID=secret");
    const sidecar = new OpenCodeSidecar({ home });
    expect(exists(joinPath(home, "opencode"))).toBe(false);
    expect(exists(sidecar.managedBinary)).toBe(true);
    expect(sidecar.managedBinary).toContain("dani-engine");
    expect(exists(joinPath(home, "engine", "data"))).toBe(false);
    expect(sidecar.runDir.startsWith(joinPath(home, "engine", "run"))).toBe(true);
    void createHash;
  });
});
