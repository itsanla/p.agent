import { createGroq } from "@ai-sdk/groq";
import { generateText, APICallError } from "ai";
import { getRedis } from "./redis";
import type { KeyState } from "./types";

export const GROQ_MODEL = process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile";
const MAX_RETRIES = 3;
// Cap on reply length. Generous (token budget is ample with multiple keys); the
// prompt keeps replies concise by default, this just prevents pathological runaways.
const MAX_OUTPUT_TOKENS = Number(process.env.GROQ_MAX_OUTPUT_TOKENS ?? 2048);

interface KeyEntry {
  apiKey: string;
  state: KeyState;
}

export interface GenerateResult {
  text: string;
  keyUsed: string; // e.g. "key2"
  tokensUsed: number;
}

/**
 * Parse a Groq reset-time string into milliseconds.
 *   "2m30.5s" → 150500   "45.2s" → 45200   "1h2m3s" → 3723000   "500ms" → 500
 */
export function parseGroqResetTime(value: string | null | undefined): number {
  if (!value) return 0;
  const trimmed = value.trim();
  if (trimmed === "") return 0;

  // Plain number → seconds (Groq sometimes returns "60").
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return Math.round(parseFloat(trimmed) * 1000);
  }

  let total = 0;
  // Order matters: match ms before s so "500ms" isn't read as "500s".
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let match: RegExpExecArray | null;
  let matched = false;
  while ((match = re.exec(trimmed)) !== null) {
    matched = true;
    const amount = parseFloat(match[1]);
    switch (match[2]) {
      case "h":
        total += amount * 3600_000;
        break;
      case "m":
        total += amount * 60_000;
        break;
      case "s":
        total += amount * 1000;
        break;
      case "ms":
        total += amount;
        break;
    }
  }
  return matched ? Math.round(total) : 0;
}

function maskKey(key: string): string {
  return `...${key.slice(-4)}`;
}

/** Detect all GROQ_API_KEY_* env vars, ordered by their numeric suffix. */
function detectKeys(): { index: number; apiKey: string }[] {
  const found: { index: number; apiKey: string }[] = [];
  for (const [name, value] of Object.entries(process.env)) {
    const m = /^GROQ_API_KEY_(\d+)$/.exec(name);
    if (m && value && value.trim() !== "") {
      found.push({ index: Number(m[1]), apiKey: value.trim() });
    }
  }
  // Fallback: a single unnumbered GROQ_API_KEY.
  if (found.length === 0 && process.env.GROQ_API_KEY?.trim()) {
    found.push({ index: 1, apiKey: process.env.GROQ_API_KEY.trim() });
  }
  return found.sort((a, b) => a.index - b.index);
}

function todayStamp(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

class GroqKeyManager {
  private keys: KeyEntry[];

  constructor() {
    this.keys = detectKeys().map(({ index, apiKey }) => ({
      apiKey,
      state: {
        index,
        maskedKey: maskKey(apiKey),
        limitRequests: null,
        limitTokens: null,
        remainingRequests: null,
        remainingTokens: null,
        resetRequestsAt: null,
        resetTokensAt: null,
        isLimited: false,
        limitedUntil: null,
        totalTokensUsed: 0,
        totalRequestsMade: 0,
        lastUsed: null,
      },
    }));
  }

  get keyCount(): number {
    return this.keys.length;
  }

  /** Load persisted daily counters from Redis into in-memory state. */
  async hydrate(): Promise<void> {
    if (this.keys.length === 0) return;
    try {
      const redis = getRedis();
      const day = todayStamp();
      await Promise.all(
        this.keys.map(async (entry) => {
          const base = `groq:stats:${day}:key${entry.state.index}`;
          const [tokens, requests, lastUsed] = await Promise.all([
            redis.get<number>(`${base}:totalTokens`),
            redis.get<number>(`${base}:totalRequests`),
            redis.get<number>(`${base}:lastUpdated`),
          ]);
          entry.state.totalTokensUsed = Number(tokens ?? 0);
          entry.state.totalRequestsMade = Number(requests ?? 0);
          entry.state.lastUsed = lastUsed != null ? Number(lastUsed) : entry.state.lastUsed;
        }),
      );
    } catch (err) {
      console.error("[groq] hydrate failed:", err);
    }
  }

  /** Snapshot of all key states (counters refreshed from Redis first). */
  async getStates(): Promise<KeyState[]> {
    await this.hydrate();
    this.refreshLimits();
    return this.keys.map((e) => ({ ...e.state }));
  }

  /** Clear stale rate-limit flags whose window has already passed. */
  private refreshLimits(): void {
    const now = Date.now();
    for (const { state } of this.keys) {
      if (state.isLimited && state.limitedUntil != null && now >= state.limitedUntil) {
        state.isLimited = false;
        state.limitedUntil = null;
      }
    }
  }

  /**
   * Pick the best key: most remaining tokens among available keys.
   * If all keys are limited, return the one that recovers soonest.
   */
  private selectKey(): KeyEntry | null {
    if (this.keys.length === 0) return null;
    this.refreshLimits();
    const now = Date.now();

    const available = this.keys.filter(
      (e) => !(e.state.isLimited && e.state.limitedUntil != null && now < e.state.limitedUntil),
    );

    if (available.length > 0) {
      // Prefer most remaining tokens; unknown (null) is treated as "plenty" so
      // fresh keys get tried before we have header data.
      return available.reduce((best, cur) => {
        const b = best.state.remainingTokens ?? Number.POSITIVE_INFINITY;
        const c = cur.state.remainingTokens ?? Number.POSITIVE_INFINITY;
        return c > b ? cur : best;
      });
    }

    // All limited → soonest to recover.
    return this.keys.reduce((soonest, cur) => {
      const s = soonest.state.limitedUntil ?? Number.POSITIVE_INFINITY;
      const c = cur.state.limitedUntil ?? Number.POSITIVE_INFINITY;
      return c < s ? cur : soonest;
    });
  }

  private applyHeaders(state: KeyState, headers: Record<string, string | undefined>): void {
    const get = (name: string): string | undefined => headers[name] ?? headers[name.toLowerCase()];
    const num = (v: string | undefined): number | null => {
      if (v == null) return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };

    const lr = num(get("x-ratelimit-limit-requests"));
    const lt = num(get("x-ratelimit-limit-tokens"));
    const rr = num(get("x-ratelimit-remaining-requests"));
    const rt = num(get("x-ratelimit-remaining-tokens"));
    if (lr != null) state.limitRequests = lr;
    if (lt != null) state.limitTokens = lt;
    if (rr != null) state.remainingRequests = rr;
    if (rt != null) state.remainingTokens = rt;

    const resetReq = get("x-ratelimit-reset-requests");
    const resetTok = get("x-ratelimit-reset-tokens");
    if (resetReq) state.resetRequestsAt = Date.now() + parseGroqResetTime(resetReq);
    if (resetTok) state.resetTokensAt = Date.now() + parseGroqResetTime(resetTok);
  }

  private async persistUsage(state: KeyState, tokensUsed: number): Promise<void> {
    try {
      const redis = getRedis();
      const base = `groq:stats:${todayStamp()}:key${state.index}`;
      const now = Date.now();
      const pipeline = redis.multi();
      pipeline.incrby(`${base}:totalTokens`, tokensUsed);
      pipeline.incrby(`${base}:totalRequests`, 1);
      pipeline.set(`${base}:lastUpdated`, now);
      // Expire after 48h so date-stamped keys self-clean (gives a daily reset).
      pipeline.expire(`${base}:totalTokens`, 172800);
      pipeline.expire(`${base}:totalRequests`, 172800);
      pipeline.expire(`${base}:lastUpdated`, 172800);
      await pipeline.exec();

      state.totalTokensUsed += tokensUsed;
      state.totalRequestsMade += 1;
      state.lastUsed = now;
    } catch (err) {
      console.error("[groq] persistUsage failed:", err);
      // Still update in-memory so the running session stays consistent.
      state.totalTokensUsed += tokensUsed;
      state.totalRequestsMade += 1;
      state.lastUsed = Date.now();
    }
  }

  /**
   * Generate a completion, automatically failing over across keys on 429.
   * Throws after MAX_RETRIES exhausted or when no keys are configured.
   */
  async generate(
    messages: { role: "user" | "assistant"; content: string }[],
    systemPrompt?: string,
    model: string = GROQ_MODEL,
    temperature?: number,
  ): Promise<GenerateResult> {
    if (this.keys.length === 0) {
      throw new Error("No Groq API keys configured (set GROQ_API_KEY_1, ...).");
    }
    await this.hydrate();

    let lastError: unknown = null;
    const triedIndexes = new Set<number>();

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const entry = this.selectKey();
      if (!entry) break;

      // Avoid hammering the same key twice unless it's our only option.
      if (triedIndexes.has(entry.state.index) && triedIndexes.size < this.keys.length) {
        const fresh = this.keys.find((e) => !triedIndexes.has(e.state.index));
        if (fresh) {
          // selectKey would re-pick the same one; force the untried key instead.
          return this.runOnce(fresh, messages, systemPrompt, model, temperature, triedIndexes).catch(
            (err) => {
              lastError = err;
              throw err;
            },
          );
        }
      }
      triedIndexes.add(entry.state.index);

      try {
        return await this.runOnce(entry, messages, systemPrompt, model, temperature, triedIndexes);
      } catch (err) {
        lastError = err;
        if (err instanceof APICallError && err.statusCode === 429) {
          this.handle429(entry.state, err.responseHeaders);
          continue; // failover to next key
        }
        // Non-rate-limit error: retry once on a different key, then give up.
        if (attempt >= 1) throw err;
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error("All Groq API keys are rate limited or unavailable.");
  }

  private async runOnce(
    entry: KeyEntry,
    messages: { role: "user" | "assistant"; content: string }[],
    systemPrompt: string | undefined,
    model: string,
    temperature: number | undefined,
    tried: Set<number>,
  ): Promise<GenerateResult> {
    tried.add(entry.state.index);
    const groq = createGroq({ apiKey: entry.apiKey });

    try {
      const result = await generateText({
        model: groq(model),
        system: systemPrompt,
        messages,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        temperature,
      });

      const headers = result.response?.headers ?? {};
      this.applyHeaders(entry.state, headers as Record<string, string | undefined>);

      const tokensUsed = result.usage?.totalTokens ?? 0;
      await this.persistUsage(entry.state, tokensUsed);

      return {
        text: result.text,
        keyUsed: `key${entry.state.index}`,
        tokensUsed,
      };
    } catch (err) {
      if (err instanceof APICallError && err.responseHeaders) {
        this.applyHeaders(entry.state, err.responseHeaders as Record<string, string | undefined>);
      }
      throw err;
    }
  }

  private handle429(state: KeyState, headers: Record<string, string> | undefined): void {
    const retryAfter = headers?.["retry-after"] ?? headers?.["Retry-After"];
    const resetTokens = headers?.["x-ratelimit-reset-tokens"];
    let waitMs = 0;
    if (retryAfter) waitMs = parseGroqResetTime(retryAfter);
    if (waitMs === 0 && resetTokens) waitMs = parseGroqResetTime(resetTokens);
    if (waitMs === 0) waitMs = 60_000; // sensible default

    state.isLimited = true;
    state.limitedUntil = Date.now() + waitMs;
    state.remainingTokens = 0;
    console.warn(
      `[groq] key${state.index} rate limited; backing off ${Math.round(waitMs / 1000)}s`,
    );
  }
}

// Singleton: reused across requests within a single serverless instance.
declare global {
  var __groqManager: GroqKeyManager | undefined;
}

export const groqManager: GroqKeyManager =
  globalThis.__groqManager ?? (globalThis.__groqManager = new GroqKeyManager());
