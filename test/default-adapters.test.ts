import { describe, expect, it } from "bun:test";

const serverModule = new URL("../src/server.ts", import.meta.url).href;

describe("default adapters", () => {
  it("reads the OpenCode endpoint after startup configuration is applied", async () => {
    const program = `
      import { defaultAdapters } from ${JSON.stringify(serverModule)};

      process.env.DANI_FREE_OPENCODE_BASE_URL = "http://fixture.invalid/v1";
      globalThis.fetch = async (url) => {
        console.log(String(url));
        return Response.json({ data: [] });
      };

      const adapter = defaultAdapters().find((item) => item.id === "opencode");
      if (!adapter) throw new Error("OpenCode adapter is missing");
      await adapter.listModels();
    `;
    const child = Bun.spawn({ cmd: [process.execPath, "-e", program], stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout.trim()).toBe("http://fixture.invalid/v1/config/providers");
  });
});
