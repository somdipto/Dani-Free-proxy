import { describe, expect, it, afterEach } from "bun:test";
import MimoAdapter, { MAX_MIMO_DISCOVERY_BYTES } from "../src/adapters/mimo";

const BASE = "http://mimo.test";
const ENV_KEYS = ["DANI_FREE_MIMO_BASE_URL", "DANI_FREE_MIMO_PROTOCOL"];

const savedEnv: Record<string, string | undefined> = {};
const savedFetch = globalThis.fetch;

function stubFetch(response: Response): void {
  globalThis.fetch = (async () => response) as unknown as typeof fetch;
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete Bun.env[key];
    else Bun.env[key] = savedEnv[key];
  }
  globalThis.fetch = savedFetch;
});

function useEnv(entries: Record<string, string>): void {
  for (const key of ENV_KEYS) {
    if (!(key in savedEnv)) savedEnv[key] = Bun.env[key];
  }
  for (const [key, value] of Object.entries(entries)) Bun.env[key] = value;
}

function oversized(body: unknown): Response {
  const padding = "x".repeat(MAX_MIMO_DISCOVERY_BYTES + 8);
  const payload = typeof body === "object" && body !== null && !Array.isArray(body)
    ? { ...body, padding }
    : body;
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("MiMo adapter discovery cap", () => {
  it("refuses to buffer an oversized /models body and fails with the invalid-JSON reason", async () => {
    // The payload is a VALID OpenAI /models document, so a cap-less parse
    // would have returned the free model — the rejection below proves the
    // 1 MiB cap fired before the body was buffered whole.
    useEnv({ DANI_FREE_MIMO_BASE_URL: BASE });
    stubFetch(oversized({ data: [{ id: "mimo/free-model" }] }));
    const adapter = new MimoAdapter();
    const error = await adapter.listModels().then(
      () => { throw new Error("expected listModels to reject"); },
      (caught) => caught,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("MiMo Code model discovery returned invalid JSON");
  });

  it("refuses to buffer an oversized /provider body on the opencode protocol path", async () => {
    useEnv({ DANI_FREE_MIMO_BASE_URL: BASE, DANI_FREE_MIMO_PROTOCOL: "opencode" });
    stubFetch(
      oversized({
        all: [{ id: "mimo", name: "MiMo", models: { "free-model": { name: "Free" } } }],
        connected: ["mimo"],
      }),
    );
    const adapter = new MimoAdapter();
    const error = await adapter.listModels().then(
      () => { throw new Error("expected listModels to reject"); },
      (caught) => caught,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("MiMo OpenCode provider discovery returned invalid JSON");
  });

  it("still parses a normal-sized /models body", async () => {
    useEnv({ DANI_FREE_MIMO_BASE_URL: BASE });
    stubFetch(
      new Response(JSON.stringify({ data: [{ id: "mimo/free-model", name: "Free" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const adapter = new MimoAdapter();
    const models = await adapter.listModels();
    expect(models.map((model) => model.id)).toEqual(["mimo/free-model"]);
  });
});
