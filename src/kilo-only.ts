import { KiloAdapter } from "./adapters/kilo";
import { applyBackendEnvironment, loadConfig } from "./config";
import { KILO_FREE_MODELS, createRouterServer } from "./server";

// The Kilo-only listener resolves the same JSON config file and environment
// variables as the standard listener, but keeps its own defaults: port 4290
// and a 120s request deadline. Client API-key auth is not enforced here.
const config = loadConfig(undefined, { port: 4290, requestTimeoutMs: 120_000 });
applyBackendEnvironment(config);

const server = createRouterServer({
  host: config.host,
  port: config.port,
  timeoutMs: config.requestTimeoutMs,
  maxBodyBytes: config.bodyLimitBytes,
  attemptTimeoutMs: config.attemptTimeoutMs,
  primaryModel: KILO_FREE_MODELS[0],
  allowedModels: [...KILO_FREE_MODELS],
  adapters: [new KiloAdapter()],
});

console.log(`dani-free Kilo-only listening at http://${config.host}:${server.port}`);

const shutdown = () => server.close(true);
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
await new Promise<void>(() => undefined);
