import { Redis } from "@upstash/redis/cloudflare";
import type { Message } from "./types";
import type { KeyState } from "./types";

// Upstash Redis is a CACHE only — D1 is the source of truth. Everything here is
// safe to lose: dedup markers, reminder markers, a hot copy of recent history,
// and the live Groq rate-limit state (which Worker isolates can't hold in memory
// across requests). All helpers fail open so a Redis outage never breaks a reply.

const HISTORY_TTL = 3600; // 1h hot copy of recent messages
const DEDUP_TTL = 86400; // 24h message-dedup window
const REMINDER_TTL = 26 * 3600; // 26h Trello reminder idempotency
const KEYSTATE_TTL = 7200; // 2h live rate-limit snapshot per key

export class Cache {
  private redis: Redis | null;

  constructor(env: { UPSTASH_REDIS_REST_URL?: string; UPSTASH_REDIS_REST_TOKEN?: string }) {
    const url = env.UPSTASH_REDIS_REST_URL;
    const token = env.UPSTASH_REDIS_REST_TOKEN;
    this.redis = url && token ? new Redis({ url, token }) : null;
  }

  get enabled(): boolean {
    return this.redis !== null;
  }

  // ── Dedup / idempotency ─────────────────────────────────────────────────────

  /** Claim a message id; true if first time seen (caller should process). Fail-open. */
  async claimMessage(id: string): Promise<boolean> {
    if (!this.redis) return true;
    try {
      const res = await this.redis.set(`processed:msg:${id}`, "1", { nx: true, ex: DEDUP_TTL });
      return res === "OK";
    } catch (err) {
      console.error("[cache] claimMessage failed:", err);
      return true;
    }
  }

  /** Claim a (card,due) reminder marker; true if not yet reminded. Fail-open. */
  async claimReminder(key: string): Promise<boolean> {
    if (!this.redis) return true;
    try {
      const res = await this.redis.set(`trello:reminded:${key}`, "1", { nx: true, ex: REMINDER_TTL });
      return res === "OK";
    } catch {
      return true;
    }
  }

  // ── Working-memory cache (read-through on top of D1) ──────────────────────────

  async getHistory(phone: string): Promise<Message[] | null> {
    if (!this.redis) return null;
    try {
      return await this.redis.get<Message[]>(`chat:hist:${phone}`);
    } catch {
      return null;
    }
  }

  async setHistory(phone: string, msgs: Message[]): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.set(`chat:hist:${phone}`, msgs, { ex: HISTORY_TTL });
    } catch {
      /* ignore */
    }
  }

  async invalidateHistory(phone: string): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.del(`chat:hist:${phone}`);
    } catch {
      /* ignore */
    }
  }

  // ── Live Groq key state (per key index) ───────────────────────────────────────

  async getKeyState(index: number): Promise<Partial<KeyState> | null> {
    if (!this.redis) return null;
    try {
      return await this.redis.get<Partial<KeyState>>(`groq:state:${index}`);
    } catch {
      return null;
    }
  }

  async setKeyState(index: number, state: Partial<KeyState>): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.set(`groq:state:${index}`, state, { ex: KEYSTATE_TTL });
    } catch {
      /* ignore */
    }
  }

  // ── Live Tavily key state (per key index) ─────────────────────────────────────

  async getTavilyState(index: number): Promise<{ exhausted?: boolean; limitedUntil?: number } | null> {
    if (!this.redis) return null;
    try {
      return await this.redis.get(`tavily:state:${index}`);
    } catch {
      return null;
    }
  }

  async setTavilyState(index: number, state: { exhausted?: boolean; limitedUntil?: number }): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.set(`tavily:state:${index}`, state, { ex: KEYSTATE_TTL });
    } catch {
      /* ignore */
    }
  }
}
