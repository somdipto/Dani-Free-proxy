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

export interface CatalogAdapterOptions {
  /** Managed `opencode serve` sidecar; its live URL and password feed the OpenCode adapter. */
  opencode?: { baseUrl: string | undefined; password: string };
}

/**
 * Adapters for the catalog-driven listener (`dani-free start`).
 * OpenCode's free models come first and Kilo's free gateway models are the
 * automatic fallback. DANI_FREE_DISABLE_OPENCODE=1 is the kill switch: Kilo only.
 * Private mode leaves OpenCode out too (its free models may be trained on).
 * Note: OpenCode's docs say its free tier is meant for OpenCode itself; the
 * owner chose to use it here, and the kill switch exists for that reason.
 */
export function catalogAdapters(options: CatalogAdapterOptions = {}): BackendAdapter[] {
  const adapters: BackendAdapter[] = [];
  if (opencodeEnabled()) {
    const sidecar = options.opencode;
    adapters.push(sidecar
      ? new OpenCodeAdapter({ resolveBaseUrl: () => sidecar.baseUrl, apiKey: sidecar.password })
      : new OpenCodeAdapter());
  }
  adapters.push(new KiloAdapter());
  return adapters;
}

export function opencodeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.DANI_FREE_DISABLE_OPENCODE === "1") return false;
  if (env.DANI_FREE_PRIVATE_MODE === "1") return false;
  return true;
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
