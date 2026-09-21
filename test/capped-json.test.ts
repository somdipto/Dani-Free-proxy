import { describe, expect, it } from "bun:test";
import { readCappedJson } from "../src/adapters/capped-json";

const MESSAGES = {
  empty: "test backend returned an empty discovery response",
  oversize: (maxBytes: number) => `test backend discovery response exceeds ${maxBytes} bytes`,
};

describe("readCappedJson", () => {
  it("parses a normal-sized JSON body", async () => {
    const response = new Response(JSON.stringify({ data: [{ id: "x/free" }] }));
    const payload = await readCappedJson(response, 1_048_576, MESSAGES);
    expect(payload).toEqual({ data: [{ id: "x/free" }] });
  });

  it("throws the caller's oversize message when a single chunk exceeds the cap", async () => {
    // One chunk larger than the cap must trip it without being buffered whole.
    const response = new Response(`{"padding":"${"x".repeat(64)}"}`);
    const error = await readCappedJson(response, 8, MESSAGES).then(
      () => { throw new Error("expected readCappedJson to reject"); },
      (caught) => caught,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("test backend discovery response exceeds 8 bytes");
  });

  it("throws the caller's empty message when the response has no body", async () => {
    const response = new Response(null, { status: 200 });
    // A null-body Response still reports .body as null in Bun.
    const error = await readCappedJson(response, 1_048_576, MESSAGES).then(
      () => { throw new Error("expected readCappedJson to reject"); },
      (caught) => caught,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("test backend returned an empty discovery response");
  });

  it("throws on an invalid JSON body under the cap", async () => {
    const response = new Response("not json");
    await expect(readCappedJson(response, 1_048_576, MESSAGES)).rejects.toThrow(SyntaxError);
  });
});
