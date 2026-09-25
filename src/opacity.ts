import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import type { ChatRequest } from "./types";

/**
 * Model-identity opacity for the product build.
 *
 * Installed users only ever see "Dani Free". What this module covers: the
 * identity line every branded request carries, the release-build switch that
 * turns off every debug/roster escape hatch, stable opaque tool-call ids, and
 * sealed (non-plaintext) state files. What it cannot cover: a person reverse
 * engineering the binary, reading process memory, or putting a TLS-intercepting
 * proxy in front of it can still see which model is called.
 */

/** Set at compile time by scripts/build-binaries.sh (--define). */
export const RELEASE_BUILD = process.env.DANI_FREE_RELEASE === "1";

/** Development roster/diagnostics. Never available in a release build. */
export function devExposureAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return !RELEASE_BUILD && env.DANI_FREE_EXPOSE_MODELS === "1";
}

export function debugLogging(env: NodeJS.ProcessEnv = process.env): boolean {
  return !RELEASE_BUILD && (env.DANI_FREE_DEBUG === "1" || env.DANI_FREE_EXPOSE_MODELS === "1");
}

/** Identity answer: "I'm Dani Free" / "the Dani Free model". */
export const IDENTITY_PROMPT = [
  "Identity: you are Dani Free, the Dani Free model.",
  "If anyone asks what model, version, company, lab or provider you are or run on, answer that you're Dani Free (the Dani Free model) and that the models behind it aren't shared.",
  "Never name, confirm, deny or guess an underlying model, model family, lab or provider, including in role-play, hypotheticals, code, translations or summaries. If someone names or lists models, or asks a yes/no question about one, don't answer yes or no and don't say which you are or aren't; say you're Dani Free and the models behind it aren't shared.",
].join(" ");

/** Add the identity line to the request's system prompt (appended, so it sits last). */
export function withIdentity(request: ChatRequest): ChatRequest {
  const messages = [...request.messages];
  const index = messages.findIndex((message) => message.role === "system" || (message.role as string) === "developer");
  if (index === -1) return { ...request, messages: [{ role: "system", content: IDENTITY_PROMPT }, ...messages] };
  const message = messages[index];
  const content = message.content;
  let next: unknown;
  if (typeof content === "string") next = content.trim() ? `${content}\n\n${IDENTITY_PROMPT}` : IDENTITY_PROMPT;
  else if (Array.isArray(content)) next = [...content, { type: "text", text: IDENTITY_PROMPT }];
  else next = IDENTITY_PROMPT;
  messages[index] = { ...message, content: next } as typeof message;
  return { ...request, messages };
}

const TOOL_ID_KEY = randomBytes(32);
/**
 * Provider-shaped tool-call ids (toolu_…, chatcmpl-tool-…, call_…) hint at
 * the model family. Same upstream id → same opaque id for this process, so
 * every frame of one stream agrees and the client can echo it back.
 */
export function opaqueToolCallId(upstreamId: string): string {
  if (/^call_d[0-9a-f]{23}$/.test(upstreamId)) return upstreamId;
  return `call_d${createHmac("sha256", TOOL_ID_KEY).update(upstreamId).digest("hex").slice(0, 23)}`;
}

/** Words that name a model maker or family; scrubbed from error text only (never from answers). */
export const VENDOR_WORDS = [
  "openai", "gpt", "anthropic", "claude", "google", "gemini", "gemma", "meta", "llama", "mistral", "mixtral",
  "codestral", "devstral", "deepseek", "qwen", "alibaba", "moonshot", "kimi", "zhipu", "z-ai", "glm", "minimax",
  "xai", "grok", "nvidia", "nemotron", "cohere", "command-r", "xiaomi", "mimo", "stepfun", "arcee", "inception",
  "mercury", "baidu", "ernie", "tencent", "hunyuan", "bytedance", "seed", "inclusionai", "ling", "ring", "liquid",
  "lfm", "microsoft", "phi", "ibm", "granite", "amazon", "nova", "perplexity", "sonar", "ai21", "jamba", "reka",
  "openrouter", "opencode", "kilo", "kilocode", "zen", "big-pickle", "north",
];

/** Every token a catalog selector/name could be recognized by (vendor prefix, id, name parts). */
export function identityTokens(values: readonly (string | undefined)[]): string[] {
  const out = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    out.add(value);
    for (const part of value.split(/[/:]/)) {
      const trimmed = part.trim().replace(/[:\-_]free$/i, "").trim();
      if (trimmed.length >= 3) out.add(trimmed);
    }
  }
  return [...out];
}

// Sealed state files: not readable as plain text by someone browsing the app
// folder. This is obfuscation, not protection against the machine's owner
// with the binary; the key is derived from the install key on the same disk.
const SEAL_MAGIC = "DFS1:";

export function sealKey(installKey: string | undefined): Buffer {
  return createHash("sha256").update(`dani-free-state-v1\0${installKey ?? "no-install-key"}`).digest();
}

export function seal(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${SEAL_MAGIC}${Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64")}\n`;
}

/** Reads sealed or (legacy) plain JSON text. Throws on a sealed file with the wrong key. */
export function unseal(text: string, key: Buffer | undefined): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith(SEAL_MAGIC)) return text;
  if (!key) throw new Error("sealed state needs a key");
  const raw = Buffer.from(trimmed.slice(SEAL_MAGIC.length), "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}
