import { KiloAdapter } from "./adapters/kilo";
import { OpenCodeAdapter } from "./adapters/opencode";
import { createRouter, type Router, type RouterOptions } from "./router";
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
  readonly router: Router;
}

/** OpenCode free ids occupy slots 1-3. `auto` starts at nemotron-3-ultra-free and walks the failover chain. */
export const OPENCODE_FREE_MODELS = [
  "opencode/nemotron-3-ultra-free",
  "opencode/muse-spark-1.3-contributor-free",
  "opencode/mimo-v2.6-flash-free",
] as const;

/** Kilo free ids occupy slots 4-6. */
export const KILO_FREE_MODELS = [
  "kilo/nex-agi/nex-n2.5-pro:free",
  "kilo/dots-studio/dots-3-note-preview:free",
  "kilo/nex-agi/nex-n2.5-mini:free",
] as const;

export function defaultAdapters(): BackendAdapter[] {
  // Fresh instances per server, not import-time singletons: the CLI bridges
  // JSON-config backend settings into the environment (applyBackendEnvironment)
  // after modules are imported but before the server is created, so adapters
  // must read the environment at construction time to see those values.
  return [new OpenCodeAdapter(), new KiloAdapter()];
}

/**
 * Adapters for the catalog-driven listener (`dani-free start`). Kilo's free
 * gateway models only by default. The OpenCode sidecar adapter is off unless
 * DANI_FREE_ENABLE_OPENCODE=1: OpenCode states its free tier may not be used
 * from other harnesses, so it is not enabled on anyone's behalf.
 */
export function catalogAdapters(): BackendAdapter[] {
  const adapters: BackendAdapter[] = [new KiloAdapter()];
  if (process.env.DANI_FREE_ENABLE_OPENCODE === "1") adapters.push(new OpenCodeAdapter());
  return adapters;
}

export function createRouterServer(options: ServerOptions = {}): RouterServer {
  // With a catalog the roster is whatever the catalog currently lists, so no fixed allowlist.
  const primaryModel = options.primaryModel ?? (options.catalog ? KILO_FREE_MODELS[0] : OPENCODE_FREE_MODELS[0]);
  const allowedModels = options.allowedModels ?? (options.catalog ? undefined : [...OPENCODE_FREE_MODELS, ...KILO_FREE_MODELS]);
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
    async fetch(request, bunServer) {
      try {
        return await router.handle(request, bunServer.requestIP(request)?.address);
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
    router,
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
