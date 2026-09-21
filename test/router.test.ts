import { describe, expect, it, spyOn } from "bun:test";
import { KiloBackendError } from "../src/adapters/kilo";
import { createRouter, DEFAULT_PRIMARY_MODEL } from "../src/router";
import type { BackendAdapter, BackendId, BackendModel, ChatRequest } from "../src/types";

function model(backend: BackendId, id: string): BackendModel {
  return { backend, id, name: id, capabilities: ["text"], contextWindow: 128_000, maxTokens: 16_000, healthy: true, source: "static" };
}

function adapter(backend: BackendId, models: BackendModel[], complete: BackendAdapter["complete"]): BackendAdapter {
  return {
    id: backend,
    async listModels() { return models; },
    async health() { return { backend, configured: true, healthy: true, checkedAt: new Date().toISOString() }; },
    complete,
  };
}

function chat(model = "auto", extra: Partial<ChatRequest> = {}, signal?: AbortSignal): Request {
  return new Request("http://router/v1/chat/completions", {
    method: "POST", signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], ...extra }),
  });
}

// Advance only router timers; the real event-loop turn drains all pending stream work.
function clock() {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let now = 0;
  const scheduled = new Map<ReturnType<typeof setTimeout>, { at: number; run: () => void }>();
  const time = spyOn(Date, "now").mockImplementation(() => now);
  const timers = spyOn(globalThis, "setTimeout").mockImplementation(((
    handler: TimerHandler,
    delay?: number,
    ...args: unknown[]
  ) => {
    const handle = realSetTimeout(() => {}, 60_000);
    scheduled.set(handle, {
      at: now + Number(delay ?? 0),
      run: () => {
        if (typeof handler === "function") (handler as (...a: unknown[]) => void)(...args);
      },
    });
    return handle;
  }) as unknown as typeof setTimeout);
  const clear = spyOn(globalThis, "clearTimeout").mockImplementation(((handle?: Parameters<typeof realClearTimeout>[0]) => {
    if (handle !== undefined) scheduled.delete(handle as ReturnType<typeof setTimeout>);
    realClearTimeout(handle);
  }) as unknown as typeof clearTimeout);
  const flush = () => new Promise<void>((resolve) => realSetTimeout(resolve, 0));
  return {
    flush,
    async advance(ms: number) {
      const target = now + ms;
      while (true) {
        const next = [...scheduled].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        scheduled.delete(next[0]);
        realClearTimeout(next[0]);
        next[1].run();
        await flush();
      }
      now = target;
      await flush();
    },
    restore() {
      for (const handle of scheduled.keys()) realClearTimeout(handle);
      clear.mockRestore();
      timers.mockRestore();
      time.mockRestore();
    },
  };
}

const primaryId = DEFAULT_PRIMARY_MODEL.slice("kilo/".length);

describe("Dani-Free failover chain", () => {
  it("walks auto through the chain OpenCode-first until one answers", async () => {
    const calls: string[] = [];
    const router = createRouter({
      failoverBackoffMs: 1,
      adapters: [
        adapter("opencode", [model("opencode", "legacy")], async () => { calls.push("opencode"); return Response.json({}); }),
        adapter("mimo", [model("mimo", "other")], async () => { calls.push("mimo"); return Response.json({}); }),
        adapter("kilo", [model("kilo", "other"), model("kilo", primaryId)], async (request) => {
          calls.push(request.model);
          return Response.json({ selected: request.model });
        }),
      ],
    });
    const response = await router.handle(chat());
    expect(await response.json()).toEqual({});
    expect(response.headers.get("x-dani-free-model")).toBe("opencode/legacy");
    expect(calls).toEqual(["opencode"]);
  });

  it("honours an explicit modelChain order", async () => {
    const calls: string[] = [];
    const router = createRouter({
      failoverBackoffMs: 1,
      modelChain: ["kilo/b", "kilo/a"],
      adapters: [adapter("kilo", [model("kilo", "a"), model("kilo", "b")], async (request) => {
        calls.push(request.model);
        return Response.json({ ok: request.model });
      })],
    });
    const response = await router.handle(chat());
    expect(await response.json()).toEqual({ ok: "b" });
    expect(response.headers.get("x-dani-free-model")).toBe("kilo/b");
    expect(calls).toEqual(["b"]);
  });

  it("discovers every chain backend concurrently instead of one round trip at a time", async () => {
    type Gate = {
      promise: Promise<BackendModel[]>;
      resolve: (value: BackendModel[] | PromiseLike<BackendModel[]>) => void;
      reject: (reason?: unknown) => void;
    };
    const gates: Record<string, Gate> = {
      opencode: Promise.withResolvers<BackendModel[]>(),
      kilo: Promise.withResolvers<BackendModel[]>(),
    };
    const started: BackendId[] = [];
    const bothStarted = Promise.withResolvers<void>();
    const backend = (id: BackendId) => {
      const base = adapter(id, [], async () => Response.json({ ok: id }));
      base.listModels = async () => {
        started.push(id);
        if (started.length === 2) bothStarted.resolve();
        return gates[id].promise;
      };
      return base;
    };
    const router = createRouter({
      failoverBackoffMs: 1,
      allowedModels: ["opencode/a", "kilo/b"],
      adapters: [backend("opencode"), backend("kilo")],
    });
    const pending = router.handle(chat());
    // Kilo's discovery must start even though OpenCode's has not resolved yet.
    const concurrent = await Promise.race([
      bothStarted.promise.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250)),
    ]);
    expect(concurrent).toBe(true);
    gates.opencode.resolve([model("opencode", "a")]);
    gates.kilo.resolve([model("kilo", "b")]);
    const response = await pending;
    expect(await response.json()).toEqual({ ok: "opencode" });
    expect(response.headers.get("x-dani-free-model")).toBe("opencode/a");
  });

  it("fails over after a 429 and labels the model that answered", async () => {
    const calls: string[] = [];
    const router = createRouter({
      failoverBackoffMs: 1,
      adapters: [adapter("kilo", [model("kilo", "a"), model("kilo", "b")], async (request) => {
        calls.push(request.model);
        if (request.model === "a") return new Response("slow down", { status: 429, statusText: "Too Many Requests" });
        return Response.json({ ok: "b" });
      })],
    });
    const response = await router.handle(chat());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: "b" });
    expect(response.headers.get("x-dani-free-model")).toBe("kilo/b");
    expect(calls).toEqual(["a", "b"]);
  });

  it("fails over on a 408 and labels the model that answered", async () => {
    const calls: string[] = [];
    const router = createRouter({
      failoverBackoffMs: 1,
      adapters: [adapter("kilo", [model("kilo", "a"), model("kilo", "b")], async (request) => {
        calls.push(request.model);
        if (request.model === "a") return new Response("upstream timeout", { status: 408, statusText: "Request Timeout" });
        return Response.json({ ok: "b" });
      })],
    });
    const response = await router.handle(chat());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: "b" });
    expect(response.headers.get("x-dani-free-model")).toBe("kilo/b");
    expect(calls).toEqual(["a", "b"]);
  });

  it("tries an explicit model first, then the rest of the chain excluding it", async () => {
    const calls: string[] = [];
    const router = createRouter({
      failoverBackoffMs: 1,
      adapters: [
        adapter("opencode", [model("opencode", "c")], async (request) => { calls.push(request.model); return Response.json({ ok: "c" }); }),
        adapter("kilo", [model("kilo", "a"), model("kilo", "b")], async (request) => {
          calls.push(request.model);
          return new Response("congested", { status: 429 });
        }),
      ],
    });
    const response = await router.handle(chat("kilo/a"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: "c" });
    expect(response.headers.get("x-dani-free-model")).toBe("opencode/c");
    expect(calls).toEqual(["a", "c"]);
  });

  it.each([408, 429, 503])("fails over on HTTP %s and reports every attempt when the chain is exhausted", async (status) => {
    const calls: string[] = [];
    const router = createRouter({
      failoverBackoffMs: 1,
      adapters: [adapter("kilo", [model("kilo", primaryId), model("kilo", "other")], async (request) => {
        calls.push(request.model);
        return new Response("quota exhausted", { status, statusText: "Upstream refusal" });
      })],
    });
    const response = await router.handle(chat());
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error.code).toBe("all_models_failed");
    expect(body.attempts.map((attempt: { model: string }) => attempt.model)).toEqual([`kilo/${primaryId}`, "kilo/other"]);
    expect(body.attempts[0].status).toBe(status);
    expect(body.attempts[0].reason).toContain(String(status));
    expect(calls).toEqual([primaryId, "other"]);
  });

  it("passes through a non-retryable 401 without failing over", async () => {
    let calls = 0;
    const router = createRouter({
      failoverBackoffMs: 1,
      adapters: [adapter("kilo", [model("kilo", primaryId), model("kilo", "other")], async () => {
        calls++;
        throw new KiloBackendError("http://upstream", 401, "Gateway refusal", '{"error":"exhausted"}');
      })],
    });
    const response = await router.handle(chat());
    expect([response.status, response.statusText, await response.text()]).toEqual([401, "Gateway refusal", '{"error":"exhausted"}']);
    expect(calls).toBe(1);
  });

  it.each([408, 429, 503])("fails over on retryable typed HTTP %s errors", async (status) => {
    const calls: string[] = [];
    const router = createRouter({
      failoverBackoffMs: 1,
      adapters: [adapter("kilo", [model("kilo", primaryId), model("kilo", "other")], async (request) => {
        calls.push(request.model);
        throw new KiloBackendError("http://upstream", status, "Gateway refusal", '{"error":"exhausted"}');
      })],
    });
    const response = await router.handle(chat());
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error.code).toBe("all_models_failed");
    expect(body.attempts).toHaveLength(2);
    expect(body.attempts[0].reason).toContain("exhausted");
    expect(calls).toEqual([primaryId, "other"]);
  });

  it("returns 503 with per-model reasons when every model fails differently", async () => {
    const calls: string[] = [];
    const router = createRouter({
      failoverBackoffMs: 1,
      adapters: [
        adapter("opencode", [model("opencode", "c")], async (request) => {
          calls.push(request.model);
          return new Response("limited", { status: 429 });
        }),
        adapter("kilo", [model("kilo", "a"), model("kilo", "b")], async (request) => {
          calls.push(request.model);
          if (request.model === "a") throw new Error("socket hangup");
          return new Response("broken", { status: 500, statusText: "Bad Gateway" });
        }),
      ],
    });
    const response = await router.handle(chat());
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error.code).toBe("all_models_failed");
    expect(body.attempts.map((attempt: { model: string }) => attempt.model)).toEqual(["opencode/c", "kilo/a", "kilo/b"]);
    expect(body.attempts[0].reason).toContain("429");
    expect(body.attempts[1].reason).toContain("socket hangup");
    expect(body.attempts[2].reason).toContain("500");
    expect(body.error.message).toContain("opencode/c");
    expect(calls).toEqual(["c", "a", "b"]);
  });

  it("does not fail over on a non-retryable 400", async () => {
    const calls: string[] = [];
    const router = createRouter({
      failoverBackoffMs: 1,
      adapters: [adapter("kilo", [model("kilo", "a"), model("kilo", "b")], async (request) => {
        calls.push(request.model);
        if (request.model === "a") return new Response("bad request", { status: 400 });
        return Response.json({ ok: "b" });
      })],
    });
    const response = await router.handle(chat());
    expect([response.status, await response.text()]).toEqual([400, "bad request"]);
    expect(response.headers.get("x-dani-free-model")).toBe("kilo/a");
    expect(calls).toEqual(["a"]);
  });

  it("treats HTTP 200 with empty content as a retryable failure", async () => {
    const calls: string[] = [];
    const empty = { choices: [{ message: { content: null }, finish_reason: "stop" }] };
    const full = { choices: [{ message: { content: "real answer" }, finish_reason: "stop" }] };
    const router = createRouter({
      failoverBackoffMs: 1,
      adapters: [adapter("kilo", [model("kilo", "a"), model("kilo", "b")], async (request) => {
        calls.push(request.model);
        return Response.json(request.model === "a" ? empty : full);
      })],
    });
    const response = await router.handle(chat());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(full);
    expect(response.headers.get("x-dani-free-model")).toBe("kilo/b");
    expect(calls).toEqual(["a", "b"]);
  });

  it("accepts tool calls as real content without failing over", async () => {
    let calls = 0;
    const toolCall = { choices: [{ message: { content: null, tool_calls: [{ id: "1", type: "function" }] }, finish_reason: "tool_calls" }] };
    const router = createRouter({
      failoverBackoffMs: 1,
      adapters: [adapter("kilo", [model("kilo", primaryId)], async () => {
        calls++;
        return Response.json(toolCall);
      })],
    });
    const response = await router.handle(chat());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(toolCall);
    expect(calls).toBe(1);
  });

  it("fails over a 429 before streaming starts and labels the answering model", async () => {
    const calls: string[] = [];
    const router = createRouter({
      failoverBackoffMs: 1,
      adapters: [adapter("kilo", [model("kilo", "a"), model("kilo", "b")], async (request) => {
        calls.push(request.model);
        if (request.model === "a") return new Response("slow down", { status: 429 });
        return new Response('data: {"delta":"hi"}\n\ndata: [DONE]\n\n', {
          headers: { "content-type": "text/event-stream" },
        });
      })],
    });
    const response = await router.handle(chat("auto", { stream: true }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("x-dani-free-model")).toBe("kilo/b");
    expect(await response.text()).toContain("data:");
    expect(calls).toEqual(["a", "b"]);
  });

  it("auto skips missing or unhealthy chain models while explicit unhealthy still 503s", async () => {
    let calls = 0;
    const other = model("kilo", "other");
    const unhealthyPrimary = { ...model("kilo", primaryId), healthy: false };
    const router = createRouter({
      failoverBackoffMs: 1,
      adapters: [adapter("kilo", [other, unhealthyPrimary], async () => {
        calls++;
        return Response.json({ ok: true });
      })],
    });
    const auto = await router.handle(chat());
    expect(auto.status).toBe(200);
    expect(await auto.json()).toEqual({ ok: true });
    expect(auto.headers.get("x-dani-free-model")).toBe("kilo/other");
    expect(calls).toBe(1);
    const explicit = await router.handle(chat(`kilo/${primaryId}`));
    expect(explicit.status).toBe(503);
    expect((await explicit.json()).error.code).toBe("model_unavailable");
    expect(calls).toBe(1);
  });

  it("auto uses the healthy chain when the primary is simply absent", async () => {
    const router = createRouter({
      failoverBackoffMs: 1,
      adapters: [adapter("kilo", [model("kilo", "other")], async () => Response.json({ ok: true }))],
    });
    const response = await router.handle(chat());
    expect(response.status).toBe(200);
    expect(response.headers.get("x-dani-free-model")).toBe("kilo/other");
  });
});

describe("Dani-Free single-model routing", () => {

  it.each([
    { tools: [{ type: "function", function: { name: "lookup" } }] },
    { reasoning_effort: "high" },
    { messages: [{ role: "user" as const, content: [{ type: "image_url", image_url: { url: "https://example.test/image" } }] }] },
  ] as Partial<ChatRequest>[])("rejects unsupported capabilities rather than switching models: %j", async (extra) => {
    let calls = 0;
    const capable = model("kilo", "capable");
    capable.capabilities = ["text", "tools", "reasoning", "image"];
    const router = createRouter([adapter("kilo", [model("kilo", primaryId), capable], async () => { calls++; return Response.json({}); })]);
    const response = await router.handle(chat("auto", extra));
    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("unsupported_capability");
    expect(calls).toBe(0);
  });

  it("passes supported capabilities to the pinned model and enforces its output limit", async () => {
    const primary = model("kilo", primaryId);
    primary.capabilities = ["text", "tools", "reasoning", "image"];
    let calls = 0;
    const router = createRouter([adapter("kilo", [primary], async () => { calls++; return Response.json({ ok: true }); })]);
    const extra = { tools: [{}], reasoning_effort: "high", messages: [{ role: "user" as const, content: [{ type: "image_url" }] }] };
    expect(await (await router.handle(chat("auto", extra))).json()).toEqual({ ok: true });
    const limited = await router.handle(chat("auto", { max_tokens: primary.maxTokens + 1 }));
    expect((await limited.json()).error.code).toBe("output_limit_exceeded");
    expect(calls).toBe(1);
  });

  it("round trips exact advertised OpenCode IDs without guessing provider aliases", async () => {
    const calls: string[] = [];
    const ids = ["provider/model", "opencode/already-prefixed"];
    const router = createRouter([adapter("opencode", ids.map((id) => model("opencode", id)), async (request) => {
      calls.push(request.model); return Response.json({ selected: request.model });
    })]);
    const listed = await (await router.handle(new Request("http://router/v1/models"))).json();
    expect(listed.data.map((entry: { id: string }) => entry.id)).toEqual(["opencode/provider/model", "opencode/already-prefixed"]);
    for (const entry of listed.data) await (await router.handle(chat(entry.id))).text();
    expect(calls).toEqual(ids);
    const missing = await router.handle(chat("opencode/model"));
    expect((await missing.json()).error.code).toBe("model_not_found");
    expect(calls).toEqual(ids);
  });

  it("restricts discovery and explicit requests to the configured allowed selectors", async () => {
    let calls = 0;
    const router = createRouter({
      primaryModel: "kilo/selected", allowedModels: ["kilo/selected"],
      adapters: [adapter("kilo", [model("kilo", "selected"), model("kilo", "hidden")], async () => { calls++; return Response.json({ ok: true }); })],
    });
    const listed = await (await router.handle(new Request("http://router/v1/models"))).json();
    expect(listed.data.map((entry: { id: string }) => entry.id)).toEqual(["kilo/selected"]);
    expect((await router.handle(chat("kilo/hidden"))).status).toBe(404);
    expect(await (await router.handle(chat())).json()).toEqual({ ok: true });
    expect(calls).toBe(1);
  });

  it.each(["model", "unknown/model", "kilo/absent"])("fails closed for explicit selector %s", async (selector) => {
    let calls = 0;
    const router = createRouter([adapter("kilo", [model("kilo", primaryId)], async () => { calls++; return Response.json({}); })]);
    const response = await router.handle(chat(selector));
    expect(response.status).toBe(selector === "model" ? 400 : 404);
    await response.text();
    expect(calls).toBe(0);
  });

  it.each(["{", "null", '{"messages":[]}', '{"model":"auto","messages":[null]}'])("returns request validation errors for %s", async (body) => {
    const router = createRouter([]);
    const response = await router.handle(new Request("http://router/v1/chat/completions", { method: "POST", body }));
    expect([400, 422]).toContain(response.status);
    expect((await response.json()).error.type).toBe("invalid_request_error");
  });
});

describe("Dani-Free request lifetime", () => {
  it("cancels a pending incoming body when Request.signal aborts", async () => {
    const controller = new AbortController();
    let cancelled = false;
    const router = createRouter([]);
    const result = router.handle(new Request("http://router/v1/chat/completions", {
      method: "POST", signal: controller.signal,
      body: new ReadableStream({ cancel() { cancelled = true; } }),
    }));
    controller.abort();
    const response = await result;
    expect(response.status).toBe(504);
    expect(cancelled).toBe(true);
  });

  it("does not let one discovery caller's cancellation poison another caller or its cache", async () => {
    const gate = Promise.withResolvers<BackendModel[]>();
    const started = Promise.withResolvers<void>();
    let discoverySignal: AbortSignal | undefined;
    let discoveries = 0;
    const backend = adapter("kilo", [], async () => Response.json({ ok: true }));
    backend.listModels = async (signal) => { discoveries++; discoverySignal = signal; started.resolve(); return gate.promise; };
    const router = createRouter([backend]);
    const controller = new AbortController();
    const first = router.handle(chat("auto", {}, controller.signal));
    await started.promise;
    const second = router.handle(chat());
    controller.abort();
    expect((await first).status).toBe(504);
    expect(discoverySignal?.aborted).toBe(false);
    gate.resolve([model("kilo", primaryId)]);
    expect(await (await second).json()).toEqual({ ok: true });
    expect(await (await router.handle(chat())).json()).toEqual({ ok: true });
    expect(discoveries).toBe(1);
  });

  it("interrupts a signal-ignoring completion and cancels its late body", async () => {
    const gate = Promise.withResolvers<Response>();
    const started = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    let upstreamSignal: AbortSignal | undefined;
    const router = createRouter([adapter("kilo", [model("kilo", primaryId)], async (_request, _model, signal) => {
      upstreamSignal = signal; started.resolve(); return gate.promise;
    })]);
    const controller = new AbortController();
    const pending = router.handle(chat("auto", {}, controller.signal));
    await started.promise;
    controller.abort();
    expect((await pending).status).toBe(504);
    expect(upstreamSignal?.aborted).toBe(true);
    gate.resolve(new Response(new ReadableStream({ cancel() { cancelled.resolve(); } })));
    await cancelled.promise;
  });

  it("times out once without invoking another model", async () => {
    const time = clock();
    try {
      let calls = 0;
      const router = createRouter({ timeoutMs: 100, adapters: [
        adapter("kilo", [model("kilo", primaryId), model("kilo", "other")], async () => { calls++; return new Promise<Response>(() => {}); }),
        adapter("mimo", [model("mimo", "other")], async () => { calls++; return Response.json({}); }),
      ] });
      const pending = router.handle(chat());
      await time.flush();
      await time.advance(100);
      expect((await pending).status).toBe(504);
      expect(calls).toBe(1);
    } finally { time.restore(); }
  });

  it("spends one deadline across incoming body, discovery, completion and response EOF", async () => {
    const time = clock();
    try {
      const discovery = Promise.withResolvers<BackendModel[]>();
      let incoming!: ReadableStreamDefaultController<Uint8Array>;
      let cancelled = false;
      const backend = adapter("kilo", [], async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })));
      backend.listModels = async () => discovery.promise;
      const router = createRouter({ adapters: [backend], timeoutMs: 100 });
      const pending = router.handle(new Request("http://router/v1/chat/completions", {
        method: "POST", body: new ReadableStream({ start(controller) { incoming = controller; } }),
      }));
      await time.advance(40);
      incoming.enqueue(new TextEncoder().encode(JSON.stringify({ model: "auto", messages: [] })));
      incoming.close();
      await time.flush();
      await time.advance(40);
      discovery.resolve([model("kilo", primaryId)]);
      const response = await pending;
      const outcome = response.text().then(() => "clean EOF", (error: Error) => error.name);
      await time.advance(20);
      expect(await outcome).toBe("AbortError");
      expect(cancelled).toBe(true);
    } finally { time.restore(); }
  });

  it("applies the receipt deadline even before the body is complete", async () => {
    const time = clock();
    try {
      let cancelled = false;
      const router = createRouter({ timeoutMs: 100 });
      const pending = router.handle(new Request("http://router/v1/chat/completions", {
        method: "POST", body: new ReadableStream({ cancel() { cancelled = true; } }),
      }));
      await time.advance(100);
      expect((await pending).status).toBe(504);
      expect(cancelled).toBe(true);
    } finally { time.restore(); }
  });

  it("errors an in-flight response read on caller abort instead of returning clean EOF", async () => {
    let cancelled = false;
    const controller = new AbortController();
    const router = createRouter([adapter("kilo", [model("kilo", primaryId)], async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })))]);
    const response = await router.handle(chat("auto", {}, controller.signal));
    const outcome = response.text().then(() => "clean EOF", (error: Error) => error.name);
    controller.abort();
    expect(await outcome).toBe("AbortError");
    expect(cancelled).toBe(true);
  });

  it("disposes the deadline on real EOF but preserves an upstream stream failure", async () => {
    const time = clock();
    try {
      let upstreamSignal: AbortSignal | undefined;
      const backend = adapter("kilo", [model("kilo", primaryId)], async (_request, _model, signal) => {
        upstreamSignal = signal; return new Response("complete");
      });
      const router = createRouter({ adapters: [backend], timeoutMs: 100 });
      expect(await (await router.handle(chat())).text()).toBe("complete");
      await time.advance(100);
      expect(upstreamSignal?.aborted).toBe(false);
      backend.complete = async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error("broken upstream")); } }));
      const failed = await router.handle(chat());
      await expect(failed.text()).rejects.toThrow("broken upstream");
    } finally { time.restore(); }
  });
});
