import { describe, expect, it } from "bun:test";
import { OpenCodeAdapter } from "../src/adapters/opencode";

describe("OpenCodeAdapter", () => {
  it("uses only its configured endpoint and advertised capabilities", async () => {
    const expectedAuth = `Basic ${Buffer.from("opencode:fixture-key", "utf8").toString("base64")}`;
    const authorizations: string[] = [];
    const postedBodies: Array<{ path: string; body: unknown }> = [];
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        authorizations.push(request.headers.get("authorization") ?? "");
        const pathname = new URL(request.url).pathname;
        if (pathname === "/v1/config/providers") {
          return Response.json({
            providers: [
              {
                id: "opencode",
                models: {
                  "muse-free": {
                    name: "Muse Free",
                    capabilities: { input: { text: true, image: true } },
                    limit: { context: 200_000, output: 32_000 },
                    status: "active",
                  },
                  "mimo-free": { name: "Mimo Free", status: "active" },
                  "muse-paid": { name: "Muse Paid", status: "active" },
                },
              },
              { id: "other", models: { "other-free": {} } },
            ],
          });
        }
        if (pathname === "/v1/session" && request.method === "POST") {
          postedBodies.push({ path: pathname, body: await request.json() });
          return Response.json({ id: "ses_fixture" });
        }
        if (pathname === "/v1/session/ses_fixture/message" && request.method === "POST") {
          postedBodies.push({ path: pathname, body: await request.json() });
          return Response.json({
            parts: [{ type: "text", text: "hello from muse" }],
            tokens: { input: 5, output: 7, total: 12 },
          });
        }
        if (pathname === "/v1/session/ses_fixture" && request.method === "DELETE") {
          return Response.json({});
        }
        return new Response("not found", { status: 404 });
      },
    });
    try {
      const adapter = new OpenCodeAdapter({
        baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
        apiKey: "fixture-key",
      });

      const models = await adapter.listModels();
      // Discovery reads /config/providers relative to the configured base,
      // keeps only the opencode provider's free ids, and prefixes them.
      expect(models.map(({ id, capabilities }) => ({ id, capabilities }))).toEqual([
        { id: "opencode/muse-free", capabilities: ["text", "tools", "reasoning", "image"] },
        { id: "opencode/mimo-free", capabilities: ["text", "tools", "reasoning"] },
      ]);
      expect(models.every((model) => model.source === "discovered")).toBe(true);
      expect(authorizations.every((value) => value === expectedAuth)).toBe(true);

      const muse = models[0];
      if (!muse) throw new Error("fixture did not return muse");
      expect(await (await adapter.complete({
        model: "auto",
        messages: [{ role: "user", content: "hi" }],
      }, muse, new AbortController().signal)).json()).toMatchObject({
        object: "chat.completion",
        model: "opencode/muse-free",
        choices: [{ message: { role: "assistant", content: "hello from muse" } }],
      });

      // The session lifecycle forwards the RAW model id (no opencode/ prefix).
      const sessionCreate = postedBodies.find((call) => call.path === "/v1/session");
      expect(sessionCreate?.body).toEqual({
        model: { providerID: "opencode", modelID: "muse-free", id: "muse-free" },
        title: "dani-free",
      });
      const messagePost = postedBodies.find((call) => call.path === "/v1/session/ses_fixture/message");
      expect(messagePost?.body).toMatchObject({
        system: "",
        parts: [{ type: "text", text: "user: hi" }],
      });
    } finally {
      upstream.stop(true);
    }
  });

  it("does not synthesize an OpenCode endpoint when none is configured", async () => {
    const adapter = new OpenCodeAdapter({ baseUrl: "" });

    expect(await adapter.listModels()).toEqual([]);
    expect(await adapter.health()).toMatchObject({ backend: "opencode", configured: false, healthy: false });
  });
});
