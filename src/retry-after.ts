/**
 * Upstream `Retry-After` handling shared by adapters (which parse it at throw
 * time) and the router (which honors it as a failover cooldown).
 *
 * Upper bound on the cooldown honored from an upstream `Retry-After` header on
 * a 429. Rate limits usually apply to the account/backend rather than one
 * model, so the next chain attempt is likely to hit the same limit — honoring
 * the requested cooldown beats burning an attempt on a guaranteed refusal.
 * The clamp keeps a hostile or absurd header from stalling the chain.
 */
export const MAX_RETRY_AFTER_BACKOFF_MS = 30_000;

/**
 * Parse an upstream `Retry-After` header into milliseconds. Accepts both forms
 * the spec allows: delta-seconds and an HTTP date. Returns undefined when the
 * header is missing, unparseable, or non-positive. Exported for tests.
 */
export function retryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get("retry-after")?.trim();
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(seconds * 1_000, MAX_RETRY_AFTER_BACKOFF_MS);
  }
  const dateMs = Date.parse(raw);
  if (!Number.isNaN(dateMs)) {
    const delta = dateMs - Date.now();
    if (delta > 0) return Math.min(delta, MAX_RETRY_AFTER_BACKOFF_MS);
  }
  return undefined;
}
