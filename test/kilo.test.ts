import { describe, expect, it } from "bun:test";
import { KiloAdapter, KiloBackendError } from "../src/adapters/kilo";

function errorAdapter(status: number, body: string): KiloAdapter {
  return new KiloAdapter({
    apiKey: "test-key",
    fetcher: (async () => new Response(body, { status, statusText: "Bad Gateway" })) as unknown as typeof fetch,
  });
}

describe("Kilo adapter error bodies", () => {
  it("caps a bloated upstream error page at 2 KiB instead of buffering it whole", async () => {
    const adapter = errorAdapter(502, `<html>${"x".repeat(100_000)}</html>`);
    const error = await adapter.listModels().then(
      () => { throw new Error("expected listModels to reject"); },
      (caught) => caught,
    );
    expect(error).toBeInstanceOf(KiloBackendError);
    expect((error as KiloBackendError).status).toBe(502);
    expect((error as KiloBackendError).body.length).toBeLessThanOrEqual(2048);
  });

  it("keeps a small upstream error body intact", async () => {
    const payload = JSON.stringify({ error: { message: "quota exhausted" } });
    const adapter = errorAdapter(429, payload);
    const error = await adapter.listModels().then(
      () => { throw new Error("expected listModels to reject"); },
      (caught) => caught,
    );
    expect(error).toBeInstanceOf(KiloBackendError);
    expect((error as KiloBackendError).body).toBe(payload);
    expect((error as KiloBackendError).message).toContain("quota exhausted");
  });

  it("diagnoses nothing when the error body fails mid-read", async () => {
    const adapter = new KiloAdapter({
      apiKey: "test-key",
      fetcher: (async () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("partial"));
            controller.error(new Error("boom"));
          },
        });
        return new Response(stream, { status: 500 });
      }) as unknown as typeof fetch,
    });
    const error = await adapter.listModels().then(
      () => { throw new Error("expected listModels to reject"); },
      (caught) => caught,
    );
    expect(error).toBeInstanceOf(KiloBackendError);
    expect((error as KiloBackendError).body).toBe("");
  });
});
