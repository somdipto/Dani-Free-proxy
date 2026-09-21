/**
 * Environment-variable parsing for entry points that bypass loadConfig.
 *
 * The Kilo-only listener (src/kilo-only.ts) does not go through
 * config.loadConfig, so its numeric env vars got a bare Number() parse. A
 * typo like DANI_FREE_REQUEST_TIMEOUT_MS=oops becomes NaN, and NaN then
 * degrades silently and differently per knob: Math.max(0, NaN) is NaN, so
 * setTimeout(..., NaN) fires immediately and every request fails with an
 * instant 504; bytes > NaN is always false, so the request-body cap is
 * silently disabled and multi-MB bodies buffer whole into memory; a NaN port
 * never binds. Invalid values fall back to the documented default with a
 * stderr warning instead. Bounds mirror config.ts's loadConfig ranges.
 */
export function envNumber(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    console.error(`dani-free: ignoring invalid ${name}=${JSON.stringify(raw.trim())}; using ${fallback}`);
    return fallback;
  }
  return parsed;
}

/** Non-empty listen host; an empty DANI_FREE_HOST would otherwise reach Bun.serve as "". */
export function envHost(name: string, fallback: string): string {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  return raw.trim();
}
