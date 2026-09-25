import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BackendModel } from "./types";

/**
 * Per-request task hints (x-dani-task) and outcome feedback (POST /v1/feedback).
 *
 * The app tells the proxy what kind of step a request is; the proxy picks
 * models suited to it (quality floor, speed) and learns, within tight bounds,
 * from privacy-safe outcome enums the app reports afterwards. No prompts,
 * text or transcripts are ever stored; no model is trained.
 */

export const TASK_HEADER = "x-dani-task";
export const REQUEST_ID_HEADER = "x-dani-request-id";
export const CLIENT_ID_HEADER = "x-dani-client-id";
export const API_VERSION = 1;

export const TASKS = ["ack", "reason", "tool_plan", "tool_repair", "summary", "chat", "title"] as const;
export type Task = typeof TASKS[number];

export const OUTCOMES = ["ok", "bad_tool_json", "unknown_tool", "empty", "task_failed", "user_undid", "timeout", "aborted"] as const;
export type Outcome = typeof OUTCOMES[number];

/** Missing header: no task routing (plain auto). Unknown value: reason. */
export function parseTask(value: string | null): Task | undefined {
  if (value === null) return undefined;
  const task = value.trim().toLowerCase();
  if (!task) return undefined;
  return (TASKS as readonly string[]).includes(task) ? task as Task : "reason";
}

export type Tier = "strong" | "ok" | "light";

/** Parameter count in billions from ids like "qwen3.8-27b", "nemotron-3-super-120b-a12b", "lfm-2.5-2.6b". */
function paramsB(id: string): number | undefined {
  const matches = [...id.toLowerCase().matchAll(/(?:^|[-_/:])(\d+(?:\.\d+)?)b(?=$|[-_:])/g)].map((match) => Number(match[1]));
  return matches.length ? Math.max(...matches) : undefined;
}

/**
 * Rough quality tier from what a model's id and limits say about it. Size
 * when the id carries one; otherwise name hints; otherwise "ok".
 */
export function modelTier(model: Pick<BackendModel, "id" | "contextWindow">): Tier {
  const id = model.id.toLowerCase();
  if (model.contextWindow > 0 && model.contextWindow < 100_000) return "light";
  const size = paramsB(id);
  if (size !== undefined) {
    if (size < 10) return "light";
    if (size >= 100) return "strong";
    return "ok";
  }
  if (/\b(nano|tiny|xs|lite|mini|small)\b|[-_](nano|tiny|xs|lite|mini|small)(?=$|[-_:])/.test(id)) return "light";
  if (/(^|[-_/])(pro|ultra|super|max|large)(?=$|[-_:])/.test(id)) return "strong";
  return "ok";
}

const TIER_RANK: Record<Tier, number> = { strong: 0, ok: 1, light: 2 };

export interface RankedRoute {
  model: BackendModel;
  /** Recent time to first answer, ms (catalog EMA), if known. */
  latencyMs?: number;
}

function stable<T>(items: T[], compare: (left: T, right: T) => number): T[] {
  return items.map((item, index) => ({ item, index }))
    .sort((left, right) => compare(left.item, right.item) || left.index - right.index)
    .map(({ item }) => item);
}

const latencyOf = (route: RankedRoute) => route.latencyMs ?? 5_000;

/**
 * Order the auto chain for a task. Input is the catalog's health/priority
 * order; output keeps every route (nothing is dropped except for `ack`, which
 * needs streaming-capable fast backends), just re-ordered.
 */
export function orderForTask<T extends RankedRoute>(task: Task, routes: T[]): T[] {
  const tier = (route: T) => modelTier(route.model);
  switch (task) {
    case "ack": {
      // Fast streaming leg: never the buffered OpenCode sidecar; fastest first, strong models last (slower to first token).
      const usable = routes.filter((route) => route.model.backend !== "opencode");
      return stable(usable, (left, right) => latencyOf(left) - latencyOf(right));
    }
    case "summary":
    case "title":
      // Light and fast first; anything else after.
      return stable(routes, (left, right) => (tier(left) === "light" ? 0 : 1) - (tier(right) === "light" ? 0 : 1) || latencyOf(left) - latencyOf(right));
    case "tool_repair":
      return stable(routes, (left, right) => TIER_RANK[tier(left)] - TIER_RANK[tier(right)]);
    case "reason":
    case "tool_plan":
    case "chat":
      // Quality floor: light models only as a last resort.
      return stable(routes, (left, right) => (tier(left) === "light" ? 1 : 0) - (tier(right) === "light" ? 1 : 0));
  }
}

interface Pending {
  selector: string;
  task: Task | "auto";
  at: number;
}

interface Counter {
  good: number;
  bad: number;
  /** Last decay, ISO. */
  decayedAt: string;
}

interface FeedbackFile {
  version: 1;
  stats: Record<string, Record<string, Counter>>;
}

export interface FeedbackOptions {
  path?: string;
  now?: () => Date;
  /** Events before a model's rank for a task moves at all. Default 20. */
  minEvents?: number;
}

const PENDING_TTL_MS = 60 * 60_000;
const MAX_PENDING = 5_000;
const HALF_LIFE_MS = 7 * 86_400_000;
const BAD: ReadonlySet<Outcome> = new Set(["bad_tool_json", "unknown_tool", "empty", "task_failed", "user_undid", "timeout"]);

export type FeedbackResult = "recorded" | "duplicate" | "unknown_request";

/**
 * Outcome store. Raw request ids live in memory for an hour only (to match
 * feedback to the model that answered); what is saved is two counters per
 * model and task, halved every 7 days, so old outcomes fade out.
 */
export class FeedbackStore {
  readonly minEvents: number;
  private readonly path?: string;
  private readonly now: () => Date;
  private readonly pending = new Map<string, Pending>();
  private readonly seen = new Set<string>();
  private data: FeedbackFile = { version: 1, stats: {} };

  constructor(options: FeedbackOptions = {}) {
    this.path = options.path;
    this.now = options.now ?? (() => new Date());
    this.minEvents = options.minEvents ?? 20;
    this.load();
  }

  track(requestId: string, selector: string, task: Task | undefined): void {
    const now = this.now().getTime();
    this.pending.set(requestId, { selector, task: task ?? "auto", at: now });
    if (this.pending.size > MAX_PENDING) {
      for (const [id, item] of this.pending) {
        if (now - item.at > PENDING_TTL_MS || this.pending.size > MAX_PENDING) this.pending.delete(id);
        else break;
      }
    }
  }

  record(requestId: string, outcome: Outcome): FeedbackResult {
    const key = `${requestId}:${outcome}`;
    if (this.seen.has(key)) return "duplicate";
    const item = this.pending.get(requestId);
    if (!item || this.now().getTime() - item.at > PENDING_TTL_MS) return "unknown_request";
    this.seen.add(key);
    if (this.seen.size > MAX_PENDING * 2) this.seen.clear();
    if (outcome === "aborted") return "recorded";
    const counter = this.counter(item.task, item.selector);
    if (BAD.has(outcome)) counter.bad += 1;
    else counter.good += 1;
    this.save();
    return "recorded";
  }

  /** Share of bad outcomes for a model on a task, or undefined below minEvents. */
  badRate(task: Task | "auto", selector: string): number | undefined {
    const counter = this.data.stats[task]?.[selector];
    if (!counter) return undefined;
    this.decay(counter);
    const total = counter.good + counter.bad;
    return total >= this.minEvents ? counter.bad / total : undefined;
  }

  /**
   * Bounded re-rank: a model whose bad rate is above the task's typical rate
   * moves down (below it, up) by at most 30% of the list. Nothing is removed.
   */
  adjust<T extends RankedRoute>(task: Task | "auto", routes: T[], selectorOf: (route: T) => string): T[] {
    const n = routes.length;
    if (n < 2) return routes;
    const rates = routes.map((route) => this.badRate(task, selectorOf(route)));
    const known = rates.filter((rate): rate is number => rate !== undefined);
    if (known.length === 0) return routes;
    const baseline = known.reduce((sum, rate) => sum + rate, 0) / known.length;
    const maxShift = Math.max(1, Math.floor(n * 0.3));
    const scored = routes.map((route, index) => {
      const rate = rates[index];
      const shift = rate === undefined ? 0 : Math.max(-maxShift, Math.min(maxShift, Math.round((rate - baseline) * n)));
      return { route, key: index + shift, index };
    });
    return scored.sort((left, right) => left.key - right.key || left.index - right.index).map((item) => item.route);
  }

  private counter(task: string, selector: string): Counter {
    const byTask = (this.data.stats[task] ??= {});
    const counter = (byTask[selector] ??= { good: 0, bad: 0, decayedAt: this.now().toISOString() });
    this.decay(counter);
    return counter;
  }

  private decay(counter: Counter): void {
    const elapsed = this.now().getTime() - Date.parse(counter.decayedAt);
    if (!(elapsed >= HALF_LIFE_MS)) return;
    const halvings = Math.floor(elapsed / HALF_LIFE_MS);
    const factor = 0.5 ** halvings;
    counter.good = Math.floor(counter.good * factor);
    counter.bad = Math.floor(counter.bad * factor);
    counter.decayedAt = new Date(Date.parse(counter.decayedAt) + halvings * HALF_LIFE_MS).toISOString();
  }

  private load(): void {
    if (!this.path || !existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as FeedbackFile;
      if (parsed?.version === 1 && parsed.stats && typeof parsed.stats === "object") this.data = parsed;
    } catch {
      /* rebuilt from new feedback */
    }
  }

  private save(): void {
    if (!this.path) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${process.pid}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(this.data)}\n`, { mode: 0o600 });
      renameSync(temporary, this.path);
    } catch {
      /* feedback is best effort */
    }
  }
}
