/**
 * Shared capped-JSON reader for adapter discovery endpoints (kilo, MiMo,
 * opencode). Discovery refetches on every cache miss, so an unbounded
 * `response.json()` parse on an anomalously large 200 body is a
 * memory-exhaustion shape. This refuses to buffer more than `maxBytes` of a
 * response body before parsing it, with caller-supplied failure messages so
 * each adapter keeps its own diagnostic wording.
 *
 * Parse a JSON response body, refusing to buffer more than `maxBytes` first.
 * A single oversized chunk trips the cap without being buffered whole; the
 * remainder of the stream is cancelled. Throws the caller's `empty` message
 * when the response has no body, the `oversize` message when the body
 * exceeds `maxBytes`, and a SyntaxError on an empty or invalid JSON body.
 */
export interface CappedJsonMessages {
  /** Thrown when the response carries no body to read. */
  empty: string;
  /** Builds the oversize error from the byte cap that fired. */
  oversize: (maxBytes: number) => string;
}

export async function readCappedJson(
  response: Response,
  maxBytes: number,
  messages: CappedJsonMessages,
): Promise<unknown> {
  if (!response.body) throw new Error(messages.empty);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      // Check the cap before retaining the chunk: a single oversized chunk
      // must trip the cap without being buffered into memory whole first.
      if (bytes + part.value.byteLength > maxBytes) {
        throw new Error(messages.oversize(maxBytes));
      }
      chunks.push(part.value);
      bytes += part.value.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks, bytes)));
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
