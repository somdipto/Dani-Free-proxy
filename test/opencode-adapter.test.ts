import { describe, expect, it } from "bun:test";
import { OpenCodeAdapter } from "../src/adapters/opencode";

describe("OpenCodeAdapter", () => {
  it("uses only its configured endpoint and advertised capabilities", async () => {
    let authorization: string | null = null;
    const forwardedModels: string[] = [];
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        authorization = request.headers.get("authorization");
        const pathname = new URL(request.url).pathname;
        if (pathname === "/v1/models") {
          return Response.json({
            data: [
              { id: "muse", capabilities: ["tools", "reasoning"], modalities: ["image"] },
              { id: "mimo" },
            ],
          });
        }
        if (pathname === "/v1/chat/completions") {
          const body = await request.json() as { model: string };
          forwardedModels.push(body.model);
          return Response.json({ selected: body.model });
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
      expect(models.map(({ id, capabilities }) => ({ id, capabilities }))).toEqual([
        { id: "opencode/muse", capabilities: ["text", "tools", "reasoning", "image"] },
        { id: "opencode/mimo", capabilities: ["text"] },
      ]);
      const muse = models[0];
      if (!muse) throw new Error("fixture did not return Muse");
      expect(await (await adapter.complete({
        model: "auto",
        messages: [{ role: "user", content: "hi" }],
      }, muse, new AbortController().signal)).json()).toEqual({ selected: "muse" });
      expect(forwardedModels).toEqual(["muse"]);
      expect(authorization as string | null).toBe("Bearer fixture-key");
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
