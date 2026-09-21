import { describe, expect, it } from "bun:test";
import { createRouterServer, defaultAdapters, KILO_FREE_MODELS, OPENCODE_FREE_MODELS } from "../src/server";
import type { BackendAdapter, BackendId, BackendModel, ChatRequest } from "../src/types";

const primaryId = OPENCODE_FREE_MODELS[0];
const coding = ["text", "tools", "reasoning"] as const;

function model(
  backend: BackendId,
  id: string,
  capabilities: BackendModel["capabilities"] = ["text"],
): BackendModel {
  return { backend, id, name: id, capabilities, contextWindow: 128_000, maxTokens: 16_000, healthy: true, source: "static" };
}

function adapter(backend: BackendId, models: BackendModel[], complete: BackendAdapter["complete"]): BackendAdapter {
  return {
    id: backend,
    async listModels() { return models; },
    async health() { return { backend, configured: true, healthy: true, checkedAt: new Date().toISOString() }; },
    complete,
  };
}

function chat(model = "auto", extra: Partial<ChatRequest> = {}): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], ...extra }),
  };
}

describe("Dani-Free standard server", () => {
  it("defaults to OpenCode then Kilo", () => {
    expect(defaultAdapters().map((item) => item.id)).toEqual(["opencode", "kilo"]);
  });

  it("lists the six free ids in preference order and pins auto to Muse Spark 1.3", async () => {
    const calls: string[] = [];
    const kiloModels = KILO_FREE_MODELS.map((id) => model("kilo", id.slice("kilo/".length))).reverse();
    const server = createRouterServer({
      host: "127.0.0.1",
      port: 0,
      adapters: [
        adapter("opencode", OPENCODE_FREE_MODELS.map((id) => model("opencode", id)).reverse(), async (request) => {
          calls.push(request.model);
          return Response.json({ selected: request.model });
        }),
        adapter("kilo", [model("kilo", "other"), ...kiloModels], async (request) => {
          calls.push(request.model);
          return Response.json({ selected: request.model });
        }),
      ],
    });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      const listed = await (await fetch(`${base}/v1/models`)).json();
      expect(listed.data.map((entry: { id: string }) => entry.id)).toEqual([...OPENCODE_FREE_MODELS, ...KILO_FREE_MODELS]);
      expect(await (await fetch(`${base}/v1/chat/completions`, chat())).json()).toEqual({ selected: primaryId });
      expect((await fetch(`${base}/v1/chat/completions`, chat(KILO_FREE_MODELS[0]))).status).toBe(200);
      expect((await fetch(`${base}/v1/chat/completions`, chat("kilo/other"))).status).toBe(404);
      expect((await fetch(`${base}/v1/chat/completions`, chat("opencode/ling-3.0-flash-fin-free"))).status).toBe(404);
      expect(calls).toEqual([primaryId, KILO_FREE_MODELS[0].slice("kilo/".length)]);
    } finally {
      server.close(true);
    }
  });

  it("does not 422 tools or reasoning on Auto or Nex", async () => {
    const muse = OPENCODE_FREE_MODELS[0];
    const server = createRouterServer({
      host: "127.0.0.1",
      port: 0,
      adapters: [
        adapter("opencode", OPENCODE_FREE_MODELS.map((id) => model("opencode", id, [...coding])), async () => {
          return Response.json({ selected: muse });
        }),
        adapter("kilo", KILO_FREE_MODELS.map((id) => model("kilo", id.slice("kilo/".length), [...coding])), async (request) => {
          return Response.json({ selected: request.model });
        }),
      ],
    });
    const base = `http://127.0.0.1:${server.port}`;
    const extra = { tools: [{ type: "function", function: { name: "lookup" } }], reasoning_effort: "high" };
    try {
      expect((await fetch(`${base}/v1/chat/completions`, chat("auto", extra))).status).toBe(200);
      expect((await fetch(`${base}/v1/chat/completions`, chat(KILO_FREE_MODELS[0], extra))).status).toBe(200);
    } finally {
      server.close(true);
    }
  });

  it("keeps an explicit allowlist instead of replacing it", async () => {
    const server = createRouterServer({
      host: "127.0.0.1",
      port: 0,
      primaryModel: "kilo/selected",
      allowedModels: ["kilo/selected", "kilo/extra"],
      adapters: [adapter("kilo", [model("kilo", "selected"), model("kilo", "extra"), model("kilo", "hidden")], async (request) => {
        return Response.json({ selected: request.model });
      })],
    });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      const listed = await (await fetch(`${base}/v1/models`)).json();
      expect(listed.data.map((entry: { id: string }) => entry.id)).toEqual(["kilo/selected", "kilo/extra"]);
      expect((await fetch(`${base}/v1/chat/completions`, chat("kilo/hidden"))).status).toBe(404);
      expect(await (await fetch(`${base}/v1/chat/completions`, chat())).json()).toEqual({ selected: "selected" });
    } finally {
      server.close(true);
    }
  });
});
