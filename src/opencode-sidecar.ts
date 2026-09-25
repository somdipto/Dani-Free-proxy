import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Runs the genuine `opencode serve` sidecar for the OpenCode backend.
 *
 * - Install: a pinned OpenCode release is downloaded once into
 *   <home>/opencode/bin and checked against the release's published SHA-256
 *   before it is unpacked. No global install, no PATH changes.
 * - Isolation: the sidecar gets its own config/data/cache/state dirs and an
 *   empty working dir, so it never reads or changes the user's own OpenCode
 *   setup or project files.
 * - Tools: OpenCode's free tier only answers when OpenCode's own tool set is
 *   offered, so the tools stay listed but every permission is "ask" and the
 *   adapter rejects each request. Nothing on this machine is read, run,
 *   written or fetched by the sidecar.
 * - Auth: a random server password per run, shared only with the adapter.
 * - Opacity: installed users must not be able to tell which model answers.
 *   The sidecar lives in <home>/engine as "dani-engine", and its database
 *   and log (which record model ids) go to a per-run directory that is
 *   wiped on stop and swept on the next start.
 */

export const OPENCODE_VERSION = "1.18.32";

/** Release assets and their published SHA-256 digests (GitHub release v1.18.32). */
export const OPENCODE_ASSETS: Record<string, { name: string; sha256: string }> = {
  "darwin-arm64": { name: "opencode-darwin-arm64.zip", sha256: "fa643f93401c13508d8d513780e54ce9cc01203d501114be9b88d62408b8101f" },
  "darwin-x64": { name: "opencode-darwin-x64.zip", sha256: "a24bf10499382f8855e19d2a081b8683e4ab99c7c2affb32dc89b17c8a00ccd6" },
  "linux-arm64": { name: "opencode-linux-arm64.tar.gz", sha256: "568461b7d4d8c19865c97e9a1102e613049c6039d01fe772154de873c1865840" },
  "linux-arm64-musl": { name: "opencode-linux-arm64-musl.tar.gz", sha256: "abf302edbc996548e28417dcdf7f67109fd95c7344f813a312633a818986204d" },
  "linux-x64": { name: "opencode-linux-x64.tar.gz", sha256: "3046e0404fdc60fb80307e7a47824ba07477364178a4d09baa8548496dd6d43b" },
  "linux-x64-musl": { name: "opencode-linux-x64-musl.tar.gz", sha256: "1ce4699c8a9470ad806fa824112cd30b5d51b4038c29231189486302ef394d94" },
  "windows-arm64": { name: "opencode-windows-arm64.zip", sha256: "5c1c21e85b694ac3fedccff22f934484c29273d5b5780eff006960304108e124" },
  "windows-x64": { name: "opencode-windows-x64.zip", sha256: "1483c72d5adced825590a0ecf8cc18b3e87e535960a125dbf539d33bce135d0f" },
};

const RELEASE_BASE = `https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}`;
const LATEST_RELEASE_API = "https://api.github.com/repos/anomalyco/opencode/releases/latest";
/** A new engine release is adopted only after it has been public this long (bad releases get pulled fast). */
export const ENGINE_MIN_RELEASE_AGE_MS = 48 * 60 * 60 * 1000;

/** "1.18.32" > "1.18.9"; non-numeric parts compare as 0. */
export function newerVersion(candidate: string, current: string): boolean {
  const a = candidate.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const b = current.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) > (b[index] ?? 0);
  }
  return false;
}

interface EngineState {
  /** Engine version in use, when newer than the built-in pin. */
  version?: string;
  /** Previous working version, for rollback. */
  previous?: string;
  /** Versions that failed to install or start: never retried. */
  rejected?: string[];
  checkedAt?: string;
}

export type EngineUpdateResult =
  | { status: "current" | "disabled" | "too_new" | "rejected" | "no_asset" | "check_failed"; version?: string; error?: string }
  | { status: "updated"; version: string; previous: string };
const START_TIMEOUT_MS = 45_000;
const RESTART_DELAY_MS = 5_000;

export const SIDECAR_CONFIG = {
  $schema: "https://opencode.ai/config.json",
  autoupdate: false,
  share: "disabled",
  permission: { "*": "ask" },
};

export function platformKey(platform = process.platform, arch = process.arch): string | undefined {
  const cpu = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : undefined;
  if (!cpu) return undefined;
  if (platform === "darwin") return `darwin-${cpu}`;
  if (platform === "win32") return `windows-${cpu}`;
  if (platform === "linux") {
    const musl = existsSync("/etc/alpine-release") || (() => {
      try {
        return readdirSync("/lib").some((name) => name.startsWith("ld-musl-"));
      } catch {
        return false;
      }
    })();
    return `linux-${cpu}${musl ? "-musl" : ""}`;
  }
  return undefined;
}

export interface SidecarOptions {
  /** Dani Free home; the sidecar lives under <home>/opencode. */
  home: string;
  /** Use this binary instead of the managed install. */
  binary?: string;
  /** Never download OpenCode. */
  noInstall?: boolean;
  log?: (line: string) => void;
  fetch?: typeof fetch;
}

function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number }): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr?.on("data", () => undefined);
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("exit", (code) => { clearTimeout(timer); resolve({ code, stdout }); });
  });
}

function findFile(dir: string, name: string): string | undefined {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (entry === name && statSync(path).isFile()) return path;
    if (statSync(path).isDirectory()) {
      const nested = findFile(path, name);
      if (nested) return nested;
    }
  }
  return undefined;
}

/** Move an install from <home>/opencode to <home>/engine, renaming the binary. */
function migrateLegacyRoot(legacy: string, root: string, exeName: string): void {
  try {
    if (!existsSync(legacy) || existsSync(root)) return;
    renameSync(legacy, root);
    const oldExe = join(root, "bin", OPENCODE_VERSION, process.platform === "win32" ? "opencode.exe" : "opencode");
    if (existsSync(oldExe)) renameSync(oldExe, join(root, "bin", OPENCODE_VERSION, exeName));
    for (const dir of ["data", "state"]) rmSync(join(root, dir), { recursive: true, force: true });
  } catch {
    /* fresh install path handles it */
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Remove per-run dirs left by proxies that are no longer running. */
function sweepRunDirs(parent: string, keep: string): void {
  if (!existsSync(parent)) return;
  for (const name of readdirSync(parent)) {
    const dir = join(parent, name);
    if (dir === keep) continue;
    const pid = Number(name.split("-")[0]);
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && pidAlive(pid)) continue;
    if (pid === process.pid) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* try again next start */
    }
  }
}

export class OpenCodeSidecar {
  readonly root: string;
  readonly password = randomBytes(24).toString("base64url");
  private child?: ChildProcess;
  private stopping = false;
  /** Set by shutdown: no start, restart or respawn may happen after it. */
  private disposed = false;
  private url?: string;
  private readonly log: (line: string) => void;
  private readonly fetchFn: typeof fetch;
  /** Per-run data/state (session database, log). Removed on stop. */
  readonly runDir: string;

  constructor(private readonly options: SidecarOptions) {
    this.root = join(options.home, "engine");
    migrateLegacyRoot(join(options.home, "opencode"), this.root, this.exeName);
    this.runDir = join(this.root, "run", `${process.pid}-${randomBytes(4).toString("hex")}`);
    this.log = options.log ?? (() => undefined);
    this.fetchFn = options.fetch ?? fetch;
  }

  get baseUrl(): string | undefined {
    return this.url;
  }

  private get exeName(): string {
    return process.platform === "win32" ? "dani-engine.exe" : "dani-engine";
  }

  get managedBinary(): string {
    return this.binaryFor(this.activeVersion);
  }

  binaryFor(version: string): string {
    return join(this.root, "bin", version, this.exeName);
  }

  /** The built-in pinned version, or a newer verified one adopted by checkForUpdate. */
  get activeVersion(): string {
    const state = this.readState();
    return state.version && newerVersion(state.version, OPENCODE_VERSION) && existsSync(this.binaryFor(state.version)) ? state.version : OPENCODE_VERSION;
  }

  private readState(): EngineState {
    try {
      return JSON.parse(readFileSync(join(this.root, "engine.json"), "utf8")) as EngineState;
    } catch {
      return {};
    }
  }

  private writeState(state: EngineState): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    writeFileSync(join(this.root, "engine.json"), `${JSON.stringify(state)}\n`, { mode: 0o600 });
  }

  /**
   * Daily engine update, no code push needed. Takes the latest stable
   * release only when it is newer than what runs now, has been public for
   * 48h, and its asset matches the SHA-256 digest GitHub publishes for it.
   * The new build must start and list its free models; otherwise the
   * previous version keeps running and the new one is never retried.
   * DANI_FREE_ENGINE_AUTOUPDATE=0 turns this off.
   */
  async checkForUpdate(options: { now?: () => number; signal?: AbortSignal } = {}): Promise<EngineUpdateResult> {
    if (process.env.DANI_FREE_ENGINE_AUTOUPDATE === "0" || this.options.binary) return { status: "disabled" };
    const now = options.now?.() ?? Date.now();
    const state = this.readState();
    const current = this.activeVersion;
    let release: { tag_name?: string; published_at?: string; draft?: boolean; prerelease?: boolean; assets?: Array<{ name?: string; digest?: string; browser_download_url?: string }> };
    try {
      const response = await this.fetchFn(LATEST_RELEASE_API, { headers: { accept: "application/vnd.github+json" }, signal: options.signal });
      if (!response.ok) return { status: "check_failed", error: `HTTP ${response.status}` };
      release = await response.json() as typeof release;
    } catch (error) {
      return { status: "check_failed", error: error instanceof Error ? error.message : String(error) };
    }
    this.writeState({ ...state, checkedAt: new Date(now).toISOString() });
    const version = (release.tag_name ?? "").replace(/^v/, "");
    if (!version || release.draft || release.prerelease || !newerVersion(version, current)) return { status: "current", version: current };
    if (state.rejected?.includes(version)) return { status: "rejected", version };
    const published = Date.parse(release.published_at ?? "");
    if (!Number.isFinite(published) || now - published < ENGINE_MIN_RELEASE_AGE_MS) return { status: "too_new", version };
    const key = platformKey();
    const pinned = key ? OPENCODE_ASSETS[key] : undefined;
    const asset = pinned ? release.assets?.find((item) => item.name === pinned.name) : undefined;
    const digest = asset?.digest?.match(/^sha256:([0-9a-f]{64})$/)?.[1];
    if (!asset?.browser_download_url || !digest || !asset.browser_download_url.startsWith(`https://github.com/anomalyco/opencode/releases/download/v${version}/`)) {
      return { status: "no_asset", version };
    }
    const reject = (error: string): EngineUpdateResult => {
      const latest = this.readState();
      this.writeState({ ...latest, rejected: [...new Set([...(latest.rejected ?? []), version])].slice(-10) });
      rmSync(join(this.root, "bin", version), { recursive: true, force: true });
      return { status: "rejected", version, error };
    };
    try {
      await this.install(version, asset.browser_download_url, pinned!.name, digest, options.signal);
    } catch (error) {
      return reject(error instanceof Error ? error.message : String(error));
    }
    const listed = await run(this.binaryFor(version), ["models", "opencode"], { cwd: this.prepareDirs(), env: this.env(), timeoutMs: 90_000 }).catch(() => undefined);
    const models = listed?.code === 0 ? listed.stdout.split(/\r?\n/).filter((line) => line.trim().startsWith("opencode/")) : [];
    if (models.length === 0) return reject("new engine listed no free models");
    const running = Boolean(this.child);
    this.writeState({ ...this.readState(), version, previous: current });
    if (running) {
      try {
        await this.restart();
      } catch (error) {
        // Back to the version that worked.
        this.writeState({ ...this.readState(), version: current === OPENCODE_VERSION ? undefined : current });
        const result = reject(error instanceof Error ? error.message : String(error));
        await this.restart().catch(() => undefined);
        return result;
      }
    }
    // Keep the built-in pin, the new version and the one before it.
    for (const name of existsSync(join(this.root, "bin")) ? readdirSync(join(this.root, "bin")) : []) {
      if (![OPENCODE_VERSION, version, current].includes(name) && !name.startsWith(".")) rmSync(join(this.root, "bin", name), { recursive: true, force: true });
    }
    return { status: "updated", version, previous: current };
  }

  /** Download, verify against the given SHA-256, unpack and place bin/<version>/dani-engine. */
  private async install(version: string, url: string, assetName: string, sha256: string, signal?: AbortSignal): Promise<string> {
    const response = await this.fetchFn(url, { signal, redirect: "follow" });
    if (!response.ok) throw new Error(`engine download failed: HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== sha256) throw new Error("engine download failed its checksum");
    const staging = join(this.root, "bin", `.staging-${process.pid}`);
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    try {
      const archive = join(staging, assetName);
      writeFileSync(archive, bytes);
      // bsdtar (macOS, Windows 10+) reads zip and tar.gz; GNU tar reads the Linux tar.gz.
      const unpacked = await run("tar", ["-xf", archive, "-C", staging], { timeoutMs: 120_000 });
      if (unpacked.code !== 0) throw new Error("could not unpack the engine");
      const found = findFile(staging, process.platform === "win32" ? "opencode.exe" : "opencode");
      if (!found) throw new Error("engine archive had no binary");
      const target = this.binaryFor(version);
      mkdirSync(join(this.root, "bin", version), { recursive: true });
      renameSync(found, target);
      if (process.platform !== "win32") chmodSync(target, 0o755);
      return target;
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }

  private env(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith("OPENCODE_")) delete env[key];
    return {
      ...env,
      XDG_CONFIG_HOME: join(this.root, "config"),
      XDG_DATA_HOME: join(this.runDir, "data"),
      XDG_CACHE_HOME: join(this.root, "cache"),
      XDG_STATE_HOME: join(this.runDir, "state"),
      OPENCODE_CONFIG: join(this.root, "config", "opencode", "opencode.json"),
      OPENCODE_SERVER_PASSWORD: this.password,
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
    };
  }

  private prepareDirs(): string {
    for (const dir of ["config/opencode", "cache", "work"]) mkdirSync(join(this.root, dir), { recursive: true, mode: 0o700 });
    for (const dir of ["data", "state"]) mkdirSync(join(this.runDir, dir), { recursive: true, mode: 0o700 });
    // Earlier versions kept the session database and log here.
    for (const dir of ["data", "state"]) rmSync(join(this.root, dir), { recursive: true, force: true });
    writeFileSync(join(this.root, "config", "opencode", "opencode.json"), `${JSON.stringify(SIDECAR_CONFIG, null, 2)}\n`, { mode: 0o600 });
    return join(this.root, "work");
  }

  /** The binary to run, installing the pinned release when needed. */
  async ensureBinary(signal?: AbortSignal): Promise<string> {
    if (this.options.binary) return this.options.binary;
    if (existsSync(this.managedBinary)) return this.managedBinary;
    if (this.options.noInstall) throw new Error("OpenCode is not installed and installing is turned off");
    const key = platformKey();
    const asset = key ? OPENCODE_ASSETS[key] : undefined;
    if (!asset) throw new Error(`no OpenCode build for ${process.platform}/${process.arch}`);
    await this.install(OPENCODE_VERSION, `${RELEASE_BASE}/${asset.name}`, asset.name, asset.sha256, signal);
    return this.managedBinary;
  }

  /** Start (or restart) `opencode serve` and resolve with its base URL once healthy. */
  async start(signal?: AbortSignal): Promise<string> {
    if (this.disposed) throw new Error("sidecar is shut down");
    const binary = await this.ensureBinary(signal);
    // Shutdown may have happened while the download ran.
    if (this.disposed) throw new Error("sidecar is shut down");
    sweepRunDirs(join(this.root, "run"), this.runDir);
    const cwd = this.prepareDirs();
    this.stopping = false;
    const child = spawn(binary, ["serve", "--port", "0", "--hostname", "127.0.0.1", "--pure", "--log-level", "ERROR"], {
      cwd,
      env: this.env(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    const url = await new Promise<string>((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(() => reject(new Error("OpenCode did not start in time")), START_TIMEOUT_MS);
      child.stdout?.on("data", (chunk) => {
        buffer += String(chunk);
        const match = buffer.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
      child.stderr?.on("data", () => undefined);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`OpenCode exited during start (code ${code})`)); });
    }).catch((error) => {
      child.kill();
      throw error;
    });
    this.url = url;
    child.once("exit", () => {
      if (this.child !== child) return;
      this.url = undefined;
      if (this.stopping) return;
      this.log("[free-backend] sidecar stopped, restarting");
      setTimeout(() => { if (!this.stopping && !this.disposed) void this.start().catch(() => undefined); }, RESTART_DELAY_MS);
    });
    return url;
  }

  /** Refresh OpenCode's model list from its registry. Restarts the sidecar when the list changed. */
  async refreshModels(): Promise<boolean> {
    const binary = await this.ensureBinary();
    const cwd = this.prepareDirs();
    const before = await this.listedModels();
    const result = await run(binary, ["models", "opencode", "--refresh"], { cwd, env: this.env(), timeoutMs: 90_000 }).catch(() => undefined);
    if (!result || result.code !== 0) return false;
    const after = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith("opencode/")).sort();
    const changed = after.length > 0 && after.join("\n") !== before.join("\n");
    if (changed && this.child) {
      await this.restart();
    }
    return changed;
  }

  private async listedModels(): Promise<string[]> {
    if (!this.url) return [];
    try {
      const response = await this.fetchFn(`${this.url}/config/providers`, { headers: { authorization: this.authHeader } });
      const body = await response.json() as { providers?: Array<{ id?: string; models?: Record<string, unknown> }> };
      const provider = body.providers?.find((item) => item.id === "opencode");
      return Object.keys(provider?.models ?? {}).map((id) => `opencode/${id}`).sort();
    } catch {
      return [];
    }
  }

  get authHeader(): string {
    return `Basic ${Buffer.from(`opencode:${this.password}`, "utf8").toString("base64")}`;
  }

  async restart(): Promise<string> {
    this.halt();
    return this.start();
  }

  /** Stop for good (proxy shutdown). Synchronous, so it finishes before process.exit. */
  stop(): void {
    this.disposed = true;
    this.halt();
    try {
      rmSync(this.runDir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* a locked file on Windows: swept on the next start */
    }
  }

  private halt(): void {
    this.stopping = true;
    const child = this.child;
    this.child = undefined;
    this.url = undefined;
    if (!child || child.exitCode !== null || child.pid === undefined) return;
    if (process.platform === "win32") {
      // Windows has no process groups for our parent to clean up: kill the
      // whole OpenCode tree here, and wait for it, before the proxy exits.
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 5_000 });
    } else {
      child.kill("SIGTERM");
    }
  }
}
