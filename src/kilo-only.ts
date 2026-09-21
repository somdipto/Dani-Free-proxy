import { KiloAdapter } from "./adapters/kilo";
import { KILO_FREE_MODELS, createRouterServer } from "./server";

const host = process.env.DANI_FREE_HOST ?? "127.0.0.1";
const port = Number(process.env.DANI_FREE_PORT ?? 4290);
const server = createRouterServer({
  host,
  port,
  timeoutMs: Number(process.env.DANI_FREE_REQUEST_TIMEOUT_MS ?? 120_000),
  maxBodyBytes: Number(process.env.DANI_FREE_BODY_LIMIT_BYTES ?? 4 * 1024 * 1024),
  primaryModel: KILO_FREE_MODELS[0],
  allowedModels: [...KILO_FREE_MODELS],
  adapters: [new KiloAdapter()],
});

console.log(`dani-free Kilo-only listening at http://${host}:${server.port}`);

const shutdown = () => server.close(true);
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
await new Promise<void>(() => undefined);
