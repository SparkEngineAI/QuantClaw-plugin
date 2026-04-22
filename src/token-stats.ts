import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getLiveConfig } from "./live-config.js";
import { getLoopMeta } from "./session-state.js";
import { getTargetPricing, resolvePrecisionFromProvider } from "./provider.js";
import type { Precision } from "./types.js";

export type RouteCategory = Precision;
export type TokenSource = "router" | "task";

export type TokenBucket = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  requestCount: number;
  estimatedCost: number;
};

export type SourceBuckets = Record<TokenSource, TokenBucket>;
export type LifetimeBuckets = Record<RouteCategory, TokenBucket>;

export type HourlyBucket = {
  hour: string;
  byPrecision: LifetimeBuckets;
  bySource: SourceBuckets;
};

export type SessionTokenStats = {
  sessionKey: string;
  precision?: Precision;
  taskTypeId?: string;
  fallbackPath?: Precision[];
  routedModel?: string;
  userMessage?: string;
  userMessagePreview?: string;
  byPrecision: LifetimeBuckets;
  bySource: SourceBuckets;
  firstSeenAt: number;
  lastActiveAt: number;
  loopId?: string;
  userMessagePreview?: string;
};

export type TokenStatsData = {
  lifetime: LifetimeBuckets;
  bySource: SourceBuckets;
  hourly: HourlyBucket[];
  sessions: Record<string, SessionTokenStats>;
  startedAt: number;
  lastUpdatedAt: number;
};

export type UsageEvent = {
  sessionKey: string;
  provider: string;
  model: string;
  source?: TokenSource;
  loopId?: string;
  precision?: Precision;
  taskTypeId?: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    total?: number;
  };
};

export type TokenUpdateEvent = {
  sessionKey: string;
  loopId?: string;
  stats: SessionTokenStats;
};

const listeners = new Set<(event: TokenUpdateEvent) => void>();
const MAX_HOURLY_BUCKETS = 72;
const MAX_SESSIONS = 200;

function emptyBucket(): TokenBucket {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalTokens: 0, requestCount: 0, estimatedCost: 0 };
}

function emptyLifetime(): LifetimeBuckets {
  return {
    "4bit": emptyBucket(),
    "8bit": emptyBucket(),
    "16bit": emptyBucket(),
  };
}

function emptySourceBuckets(): SourceBuckets {
  return { router: emptyBucket(), task: emptyBucket() };
}

function currentHourKey(): string {
  return new Date().toISOString().slice(0, 13);
}

function emptyStats(): TokenStatsData {
  return {
    lifetime: emptyLifetime(),
    bySource: emptySourceBuckets(),
    hourly: [],
    sessions: {},
    startedAt: Date.now(),
    lastUpdatedAt: Date.now(),
  };
}

function addToBucket(bucket: TokenBucket, usage: UsageEvent["usage"], cost: number): void {
  const input = usage?.input ?? 0;
  const output = usage?.output ?? 0;
  const cacheRead = usage?.cacheRead ?? 0;
  bucket.inputTokens += input;
  bucket.outputTokens += output;
  bucket.cacheReadTokens += cacheRead;
  bucket.totalTokens += usage?.total ?? (input + output);
  bucket.requestCount += 1;
  bucket.estimatedCost += cost;
}

function inferPrecision(event: UsageEvent): Precision {
  return event.precision ?? resolvePrecisionFromProvider(event.provider) ?? (event.loopId ? getLoopMeta(event.loopId)?.precision : undefined) ?? "8bit";
}

function calculateCost(model: string, precision: Precision, usage: UsageEvent["usage"]): number {
  const pricing = getTargetPricing(getLiveConfig(), precision, model);
  return ((usage?.input ?? 0) * pricing.inputPer1M + (usage?.output ?? 0) * pricing.outputPer1M) / 1_000_000;
}

export function lookupPricing(model: string, precision?: Precision): { inputPer1M: number; outputPer1M: number } {
  return getTargetPricing(getLiveConfig(), precision, model);
}

export function onTokenUpdate(fn: (event: TokenUpdateEvent) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export class TokenStatsCollector {
  private data: TokenStatsData = emptyStats();
  private dirty = false;
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<TokenStatsData>;
      this.data = {
        lifetime: { ...emptyLifetime(), ...(parsed.lifetime ?? {}) },
        bySource: { ...emptySourceBuckets(), ...(parsed.bySource ?? {}) },
        hourly: Array.isArray(parsed.hourly) ? parsed.hourly : [],
        sessions: parsed.sessions ?? {},
        startedAt: parsed.startedAt ?? Date.now(),
        lastUpdatedAt: parsed.lastUpdatedAt ?? Date.now(),
      };
    } catch {
      this.data = emptyStats();
    }
  }

  startAutoFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      if (this.dirty) {
        void this.flush();
      }
    }, 300_000);
    (this.flushTimer as NodeJS.Timeout).unref?.();
  }

  record(event: UsageEvent): void {
    const precision = inferPrecision(event);
    const source = event.source ?? "task";
    const cost = calculateCost(event.model, precision, event.usage);
    const now = Date.now();

    addToBucket(this.data.lifetime[precision], event.usage, cost);
    addToBucket(this.data.bySource[source], event.usage, cost);

    const hour = currentHourKey();
    let hourly = this.data.hourly.find((entry) => entry.hour === hour);
    if (!hourly) {
      hourly = { hour, byPrecision: emptyLifetime(), bySource: emptySourceBuckets() };
      this.data.hourly.push(hourly);
      if (this.data.hourly.length > MAX_HOURLY_BUCKETS) {
        this.data.hourly = this.data.hourly.slice(-MAX_HOURLY_BUCKETS);
      }
    }
    addToBucket(hourly.byPrecision[precision], event.usage, cost);
    addToBucket(hourly.bySource[source], event.usage, cost);

    if (event.sessionKey && event.loopId) {
      const compoundKey = `${event.sessionKey}::${event.loopId}`;
      let session = this.data.sessions[compoundKey];
      const meta = getLoopMeta(event.loopId);
      if (!session) {
        session = {
          sessionKey: event.sessionKey,
          loopId: event.loopId,
          userMessage: meta?.userMessage ?? meta?.userMessagePreview ?? "",
          userMessagePreview: meta?.userMessagePreview ?? "",
          firstSeenAt: now,
          lastActiveAt: now,
          precision,
          taskTypeId: meta?.taskTypeId,
          fallbackPath: meta?.fallbackPath,
          routedModel: meta?.routedModel,
          byPrecision: emptyLifetime(),
          bySource: emptySourceBuckets(),
        };
        this.data.sessions[compoundKey] = session;
      }
      session.lastActiveAt = now;
      session.userMessage = meta?.userMessage ?? session.userMessage ?? session.userMessagePreview;
      session.userMessagePreview = meta?.userMessagePreview ?? session.userMessagePreview;
      session.precision = meta?.precision ?? precision;
      session.taskTypeId = meta?.taskTypeId ?? event.taskTypeId ?? session.taskTypeId;
      session.fallbackPath = meta?.fallbackPath ?? session.fallbackPath;
      session.routedModel = meta?.routedModel ?? session.routedModel;
      addToBucket(session.byPrecision[precision], event.usage, cost);
      addToBucket(session.bySource[source], event.usage, cost);
      this.evictOldSessions();
      for (const listener of listeners) {
        try {
          listener({ sessionKey: event.sessionKey, loopId: event.loopId, stats: session });
        } catch {
          // Ignore listener errors.
        }
      }
    }

    this.data.lastUpdatedAt = now;
    this.dirty = true;
  }

  private evictOldSessions(): void {
    const keys = Object.keys(this.data.sessions);
    if (keys.length <= MAX_SESSIONS) return;
    const sorted = keys.sort((a, b) => this.data.sessions[a].lastActiveAt - this.data.sessions[b].lastActiveAt);
    for (const key of sorted.slice(0, keys.length - MAX_SESSIONS)) {
      delete this.data.sessions[key];
    }
  }

  getSummary() {
    return {
      lifetime: this.data.lifetime,
      bySource: this.data.bySource,
      lastUpdatedAt: this.data.lastUpdatedAt,
      startedAt: this.data.startedAt,
    };
  }

  getHourly(): HourlyBucket[] {
    return this.data.hourly;
  }

  getSessionStats(): SessionTokenStats[] {
    return Object.values(this.data.sessions).sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }

  async reset(): Promise<void> {
    this.data = emptyStats();
    this.dirty = true;
    await this.flush();
  }

  async flush(): Promise<void> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(this.filePath, JSON.stringify(this.data, null, 2), "utf-8");
      this.dirty = false;
    } catch {
      // Best effort.
    }
  }
}

let globalCollector: TokenStatsCollector | null = null;

export function setGlobalCollector(collector: TokenStatsCollector): void {
  globalCollector = collector;
}

export function getGlobalCollector(): TokenStatsCollector | null {
  return globalCollector;
}
