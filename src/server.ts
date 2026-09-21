import kiloAdapter from "./adapters/kilo";
import openCodeAdapter from "./adapters/opencode";
import { createRouter, type RouterOptions } from "./router";
import type { BackendAdapter } from "./types";

export interface ServerOptions extends RouterOptions {
  host?: string;
  port?: number;
  requestTimeoutMs?: number;
  bodyLimitBytes?: number;
}

export interface RouterServer {
  stop(closeActiveConnections?: boolean): void;
  close(closeActiveConnections?: boolean): void;
  readonly hostname: string;
  readonly port: number;
}

/** OpenCode free ids occupy slots 1-3. `auto` is OpenCode nemotron-3-ultra-free. */
export const OPENCODE_FREE_MODELS = [
  "opencode/nemotron-3-ultra-free",
  "opencode/muse-spark-1.3-contributor-free",
  "opencode/mimo-v2.5-free",
] as const;

/** Kilo free ids occupy slots 4-6. */
export const KILO_FREE_MODELS = [
  "kilo/nex-agi/nex-n2.5-pro:free",
  "kilo/dots-studio/dots-3-note-preview:free",
  "kilo/nex-agi/nex-n2.5-mini:free",
] as const;

export function defaultAdapters(): BackendAdapter[] {
  return [openCodeAdapter, kiloAdapter];
}

export function createRouterServer(options: ServerOptions = {}): RouterServer {
  const primaryModel = options.primaryModel ?? OPENCODE_FREE_MODELS[0];
  const allowedModels = options.allowedModels ?? [...OPENCODE_FREE_MODELS, ...KILO_FREE_MODELS];
  const router = createRouter({
    ...options,
    primaryModel,
    allowedModels,
    timeoutMs: options.timeoutMs ?? options.requestTimeoutMs,
    maxBodyBytes: options.maxBodyBytes ?? options.bodyLimitBytes,
    adapters: options.adapters ?? defaultAdapters(),
  });
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4190;
  const server = Bun.serve({
    hostname: host,
    port,
    idleTimeout: 255,
    async fetch(request) {
      try {
        return await router.handle(request);
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          return new Response(
            JSON.stringify({
              error: { message: "Backend request timed out or cancelled", type: "api_error", code: "timeout" },
            }),
            { status: 504, headers: { "content-type": "application/json; charset=utf-8" } },
          );
        }
        throw error;
      }
    },
  });
  return {
    hostname: host,
    port: server.port ?? port,
    stop(closeActiveConnections = false) {
      server.stop(closeActiveConnections);
    },
    close(closeActiveConnections = false) {
      server.stop(closeActiveConnections);
    },
  };
}

export const startServer = createRouterServer;
export const createServer = createRouterServer;
