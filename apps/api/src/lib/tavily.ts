import type { Cache } from "./cache";
import { addTavilyUsage, getTavilyUsageForMonth, type DB } from "./db";
import { logger } from "./logger";

// Multi-key Tavily manager (web search + extract). Dynamic key detection
// (TAVILY_API_KEY_*), failover across keys on 401 (key invalid/exhausted) and
// 429 (rate limit, honoring retry-after). Credits are tracked monthly per key in
// D1 (Tavily's quota resets monthly). Credit cost is computed deterministically
// from the request (basic/fast/ultra-fast = 1, advanced = 2; extract = ceil(n/5)·depth).

const log = logger("tavily");
const SEARCH_URL = "https://api.tavily.com/search";
const EXTRACT_URL = "https://api.tavily.com/extract";

export type SearchDepth = "basic" | "advanced" | "fast" | "ultra-fast";

export interface SearchOptions {
  searchDepth?: SearchDepth;
  topic?: "general" | "news";
  maxResults?: number;
  includeAnswer?: boolean | "basic" | "advanced";
  includeRawContent?: boolean | "markdown" | "text";
  timeRange?: "day" | "week" | "month" | "year";
  includeDomains?: string[];
}

export interface SearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
  rawContent?: string;
}

export interface SearchResponse {
  answer: string | null;
  results: SearchResult[];
  keyUsed: number;
}

export interface ExtractResult {
  url: string;
  rawContent: string;
}

interface KeyEntry {
  index: number;
  apiKey: string;
  exhausted: boolean; // hit monthly limit / invalid (401)
  limitedUntil: number | null; // 429 backoff (epoch ms)
}

function monthStamp(): string {
  return new Date().toISOString().slice(0, 7); // YYYY-MM (UTC)
}

function detectKeys(env: Record<string, unknown>): { index: number; apiKey: string }[] {
  const found: { index: number; apiKey: string }[] = [];
  for (const [name, value] of Object.entries(env)) {
    const m = /^TAVILY_API_KEY_(\d+)$/.exec(name);
    if (m && typeof value === "string" && value.trim() !== "") {
      found.push({ index: Number(m[1]), apiKey: value.trim() });
    }
  }
  if (found.length === 0 && typeof env.TAVILY_API_KEY === "string" && env.TAVILY_API_KEY.trim()) {
    found.push({ index: 1, apiKey: env.TAVILY_API_KEY.trim() });
  }
  return found.sort((a, b) => a.index - b.index);
}

function parseRetryAfter(v: string | null): number {
  if (!v) return 60_000;
  const n = Number(v);
  return Number.isFinite(n) ? n * 1000 : 60_000;
}

export class TavilyManager {
  private keys: KeyEntry[];
  private monthlyLimit: number;
  private used = new Map<number, number>(); // creditsUsed this month per key (D1 + session)
  private hydrated = false;

  constructor(
    env: Record<string, unknown>,
    private db: DB,
    private cache: Cache,
  ) {
    this.keys = detectKeys(env).map(({ index, apiKey }) => ({
      index,
      apiKey,
      exhausted: false,
      limitedUntil: null,
    }));
    this.monthlyLimit = Number(env.TAVILY_MONTHLY_CREDITS ?? 1000) || 1000;
  }

  get configured(): boolean {
    return this.keys.length > 0;
  }

  async hydrate(): Promise<void> {
    if (this.hydrated) return;
    this.hydrated = true;
    const rows = await getTavilyUsageForMonth(this.db, monthStamp()).catch(() => []);
    for (const r of rows) this.used.set(r.keyIndex, r.creditsUsed);
    await Promise.all(
      this.keys.map(async (k) => {
        const s = await this.cache.getTavilyState(k.index);
        if (s?.exhausted) k.exhausted = true;
        if (s?.limitedUntil) k.limitedUntil = s.limitedUntil;
      }),
    );
  }

  private remaining(k: KeyEntry): number {
    return this.monthlyLimit - (this.used.get(k.index) ?? 0);
  }

  private selectKey(tried: Set<number>): KeyEntry | null {
    const now = Date.now();
    const usable = this.keys.filter(
      (k) =>
        !k.exhausted &&
        !tried.has(k.index) &&
        this.remaining(k) > 0 &&
        !(k.limitedUntil != null && now < k.limitedUntil),
    );
    if (usable.length === 0) return null;
    return usable.reduce((best, cur) => (this.remaining(cur) > this.remaining(best) ? cur : best));
  }

  private async chargeCredits(index: number, credits: number): Promise<void> {
    this.used.set(index, (this.used.get(index) ?? 0) + credits);
    await addTavilyUsage(this.db, monthStamp(), index, credits).catch((err) =>
      log.error("usage.persist.failed", { key: index, err: err instanceof Error ? err : String(err) }),
    );
  }

  private async post<T>(url: string, key: KeyEntry, body: unknown): Promise<T> {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${key.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 401) {
      key.exhausted = true;
      await this.cache.setTavilyState(key.index, { exhausted: true });
      throw new TavilyError(401, "Tavily key unauthorized/exhausted");
    }
    if (res.status === 429) {
      key.limitedUntil = Date.now() + parseRetryAfter(res.headers.get("retry-after"));
      await this.cache.setTavilyState(key.index, { limitedUntil: key.limitedUntil });
      throw new TavilyError(429, "Tavily rate limited");
    }
    if (!res.ok) throw new TavilyError(res.status, `Tavily ${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
  }

  /** Web search with key failover. Returns synthesized answer + ranked results. */
  async search(query: string, opts: SearchOptions = {}): Promise<SearchResponse> {
    await this.hydrate();
    if (!this.configured) throw new Error("No Tavily API keys configured (set TAVILY_API_KEY_1, ...).");

    const depth = opts.searchDepth ?? "basic";
    const cost = depth === "advanced" ? 2 : 1;
    const body = {
      query,
      search_depth: depth,
      topic: opts.topic ?? "general",
      max_results: opts.maxResults ?? 5,
      include_answer: opts.includeAnswer ?? true,
      include_raw_content: opts.includeRawContent ?? false,
      ...(opts.timeRange ? { time_range: opts.timeRange } : {}),
      ...(opts.includeDomains?.length ? { include_domains: opts.includeDomains } : {}),
    };

    const tried = new Set<number>();
    let lastErr: unknown = null;
    for (let i = 0; i < this.keys.length; i++) {
      const key = this.selectKey(tried);
      if (!key) break;
      tried.add(key.index);
      try {
        const data = await this.post<TavilySearchRaw>(SEARCH_URL, key, body);
        await this.chargeCredits(key.index, data.usage?.total ?? cost);
        return {
          answer: data.answer ?? null,
          results: (data.results ?? []).map((r) => ({
            title: r.title,
            url: r.url,
            content: r.content,
            score: r.score ?? 0,
            rawContent: r.raw_content ?? undefined,
          })),
          keyUsed: key.index,
        };
      } catch (err) {
        lastErr = err;
        if (err instanceof TavilyError && (err.status === 401 || err.status === 429)) continue;
        throw err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("All Tavily keys exhausted or rate limited.");
  }

  /** Extract full content from URLs (max 20) with key failover. */
  async extract(urls: string[], depth: "basic" | "advanced" = "basic"): Promise<ExtractResult[]> {
    await this.hydrate();
    if (!this.configured || urls.length === 0) return [];
    const body = { urls: urls.slice(0, 20), extract_depth: depth, format: "markdown" };
    const tried = new Set<number>();
    for (let i = 0; i < this.keys.length; i++) {
      const key = this.selectKey(tried);
      if (!key) break;
      tried.add(key.index);
      try {
        const data = await this.post<TavilyExtractRaw>(EXTRACT_URL, key, body);
        const ok = data.results ?? [];
        const credits = Math.max(1, Math.ceil(ok.length / 5)) * (depth === "advanced" ? 2 : 1);
        if (ok.length > 0) await this.chargeCredits(key.index, credits);
        return ok.map((r) => ({ url: r.url, rawContent: r.raw_content ?? "" }));
      } catch (err) {
        if (err instanceof TavilyError && (err.status === 401 || err.status === 429)) continue;
        throw err;
      }
    }
    return [];
  }

  /** Per-key monthly credit usage for the /usage dashboard. */
  async getUsageStates(): Promise<
    { index: number; creditsUsed: number; limit: number; exhausted: boolean }[]
  > {
    await this.hydrate();
    return this.keys.map((k) => ({
      index: k.index,
      creditsUsed: this.used.get(k.index) ?? 0,
      limit: this.monthlyLimit,
      exhausted: k.exhausted || this.remaining(k) <= 0,
    }));
  }
}

export class TavilyError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "TavilyError";
  }
}

interface TavilySearchRaw {
  answer?: string | null;
  results?: { title: string; url: string; content: string; score?: number; raw_content?: string | null }[];
  usage?: { total?: number };
}
interface TavilyExtractRaw {
  results?: { url: string; raw_content?: string | null }[];
  failed_results?: { url: string; error: string }[];
}
