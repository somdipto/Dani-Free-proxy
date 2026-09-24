import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Per-install client key. Generated once (256-bit, hex), stored mode 600 next
 * to the config, and required on every request, so other local processes and
 * web pages can't use this machine's proxy. The embedding app reads the same
 * file (its path is in the ready line and runtime.json).
 */
export function loadOrCreateInstallKey(path: string): string {
  const existing = readInstallKey(path);
  if (existing) return existing;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const key = randomBytes(32).toString("hex");
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${key}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  return key;
}

export function readInstallKey(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows has no POSIX modes; the file stays in the user's profile folder.
  }
  const value = readFileSync(path, "utf8").trim();
  return /^[0-9a-f]{32,}$/i.test(value) ? value : undefined;
}

export interface RuntimeInfo {
  pid: number;
  host: string;
  port: number;
  baseUrl: string;
  startedAt: string;
  apiKeyFile?: string;
  privateMode: boolean;
}

export function writeRuntime(path: string, info: RuntimeInfo): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

/** The runtime record of a proxy that is still running, or undefined. */
export function readLiveRuntime(path: string): RuntimeInfo | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const info = JSON.parse(readFileSync(path, "utf8")) as RuntimeInfo;
    if (!Number.isInteger(info.pid) || !Number.isInteger(info.port)) return undefined;
    process.kill(info.pid, 0);
    return info;
  } catch {
    return undefined;
  }
}

/** Remove the runtime record, but only if it is ours. */
export function removeRuntime(path: string, pid = process.pid): void {
  try {
    const info = JSON.parse(readFileSync(path, "utf8")) as RuntimeInfo;
    if (info.pid === pid) rmSync(path, { force: true });
  } catch {
    // Already gone.
  }
}

export function isAddressInUse(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === "EADDRINUSE" || /EADDRINUSE|address already in use|in use/i.test(error.message);
}

/** Preferred port first, then the next nine, then any free port (0). */
export function fallbackPorts(preferred: number): number[] {
  if (preferred === 0) return [0];
  const ports = [preferred];
  for (let offset = 1; offset <= 9; offset += 1) if (preferred + offset <= 65_535) ports.push(preferred + offset);
  ports.push(0);
  return ports;
}

/** Try each port in order; only "address in use" moves on, anything else throws. */
export function listenWithFallback<T>(ports: number[], listen: (port: number) => T): { value: T; port: number; fellBack: boolean } {
  let lastError: unknown;
  for (const [index, port] of ports.entries()) {
    try {
      return { value: listen(port), port, fellBack: index > 0 };
    } catch (error) {
      if (!isAddressInUse(error)) throw error;
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("no free port");
}
