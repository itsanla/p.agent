import { and, asc, desc, eq, lt, sql } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import {
  conversations,
  memoryFacts,
  messages,
  researchTasks,
  summaries,
  tavilyUsage,
  usageCounters,
} from "../db/schema";
import { maskPhone } from "./format";
import { logger } from "./logger";
import type { Message } from "./types";

const log = logger("db");

export type DB = DrizzleD1Database<Record<string, never>>;

/** Build a Drizzle client bound to the D1 database. */
export function getDb(d1: D1Database): DB {
  return drizzle(d1);
}

// ── Chat history ──────────────────────────────────────────────────────────────

/** Recent history in chronological order (oldest first), capped to `limit`. */
export async function getChatHistory(db: DB, phone: string, limit = 50): Promise<Message[]> {
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.phone, phone))
    .orderBy(desc(messages.createdAt))
    .limit(limit);

  log.info("getChatHistory", { phone: maskPhone(phone), rows: rows.length, limit });
  return rows
    .map((r) => ({
      role: r.role as Message["role"],
      content: r.content,
      timestamp: r.createdAt,
      keyUsed: r.keyUsed ?? undefined,
      modelUsed: r.modelUsed ?? undefined,
    }))
    .reverse();
}

export interface MessageRow extends Message {
  id: number;
}

/**
 * Paginated history (newest-first by id, returned chronological). `before` loads
 * older messages (id < before) for infinite scroll-up. Includes row ids so the
 * client can paginate + cache.
 */
export async function getMessagesPage(
  db: DB,
  phone: string,
  opts: { before?: number; limit?: number } = {},
): Promise<MessageRow[]> {
  const limit = Math.min(opts.limit ?? 30, 100);
  const conds = [eq(messages.phone, phone)];
  if (opts.before && opts.before > 0) conds.push(lt(messages.id, opts.before));
  const rows = await db
    .select()
    .from(messages)
    .where(and(...conds))
    .orderBy(desc(messages.id))
    .limit(limit);
  log.info("getMessagesPage", { phone: maskPhone(phone), rows: rows.length, before: opts.before ?? null });
  return rows
    .map((r) => ({
      id: r.id,
      role: r.role as Message["role"],
      content: r.content,
      timestamp: r.createdAt,
      keyUsed: r.keyUsed ?? undefined,
      modelUsed: r.modelUsed ?? undefined,
    }))
    .reverse();
}

/** Append a message and upsert conversation metadata in one batch. */
export async function saveChatMessage(db: DB, phone: string, m: Message): Promise<void> {
  log.info("saveChatMessage", { phone: maskPhone(phone), role: m.role, chars: m.content.length, keyUsed: m.keyUsed, model: m.modelUsed });
  await db.batch([
    db.insert(messages).values({
      phone,
      role: m.role,
      content: m.content,
      keyUsed: m.keyUsed ?? null,
      modelUsed: m.modelUsed ?? null,
      createdAt: m.timestamp,
    }),
    db
      .insert(conversations)
      .values({
        phone,
        lastActive: m.timestamp,
        totalMessages: 1,
        lastMessage: m.content.slice(0, 200),
      })
      .onConflictDoUpdate({
        target: conversations.phone,
        set: {
          lastActive: m.timestamp,
          lastMessage: m.content.slice(0, 200),
          totalMessages: sql`${conversations.totalMessages} + 1`,
        },
      }),
  ]);
}

export async function setChatName(db: DB, phone: string, name: string): Promise<void> {
  await db
    .insert(conversations)
    .values({ phone, name, lastActive: Date.now() })
    .onConflictDoUpdate({ target: conversations.phone, set: { name } });
}

export async function setLastInbound(db: DB, phone: string, ts: number): Promise<void> {
  await db
    .insert(conversations)
    .values({ phone, lastInbound: ts, lastActive: ts })
    .onConflictDoUpdate({ target: conversations.phone, set: { lastInbound: ts } });
}

export async function getLastInbound(db: DB, phone: string): Promise<number | null> {
  const row = await db
    .select({ lastInbound: conversations.lastInbound })
    .from(conversations)
    .where(eq(conversations.phone, phone))
    .limit(1);
  return row[0]?.lastInbound ?? null;
}

export async function clearChatHistory(db: DB, phone: string): Promise<void> {
  await db.batch([
    db.delete(messages).where(eq(messages.phone, phone)),
    db.delete(conversations).where(eq(conversations.phone, phone)),
    db.delete(summaries).where(eq(summaries.phone, phone)),
    db.delete(memoryFacts).where(eq(memoryFacts.phone, phone)),
  ]);
}

// ── Rolling summary ─────────────────────────────────────────────────────────

export async function getSummary(db: DB, phone: string): Promise<string> {
  const row = await db
    .select({ summary: summaries.summary })
    .from(summaries)
    .where(eq(summaries.phone, phone))
    .limit(1);
  return row[0]?.summary ?? "";
}

export async function setSummary(db: DB, phone: string, summary: string): Promise<void> {
  log.info("setSummary", { phone: maskPhone(phone), chars: summary.length });
  const now = Date.now();
  await db
    .insert(summaries)
    .values({ phone, summary, updatedAt: now })
    .onConflictDoUpdate({ target: summaries.phone, set: { summary, updatedAt: now } });
}

// ── Memory facts (mirror of Vectorize) ────────────────────────────────────────

export async function recordFact(db: DB, id: string, phone: string, fact: string): Promise<void> {
  log.info("recordFact", { phone: maskPhone(phone), id, fact: fact.slice(0, 80) });
  await db
    .insert(memoryFacts)
    .values({ id, phone, fact, createdAt: Date.now() })
    .onConflictDoNothing();
}

/** Strongly-consistent exact-text dedup (Vectorize is only eventually consistent). */
export async function factExists(db: DB, phone: string, fact: string): Promise<boolean> {
  const row = await db
    .select({ id: memoryFacts.id })
    .from(memoryFacts)
    .where(and(eq(memoryFacts.phone, phone), eq(memoryFacts.fact, fact)))
    .limit(1);
  return row.length > 0;
}

// ── Usage counters (source of truth for /usage) ───────────────────────────────

export interface UsageRow {
  date: string;
  keyIndex: number;
  model: string;
  totalTokens: number;
  totalRequests: number;
  lastUpdated: number;
}

/** Atomically add usage for a (day, key, model) triple. */
export async function addUsage(
  db: DB,
  date: string,
  keyIndex: number,
  model: string,
  tokens: number,
): Promise<void> {
  log.info("addUsage", { date, keyIndex, model, tokens });
  const now = Date.now();
  await db
    .insert(usageCounters)
    .values({
      date,
      keyIndex,
      model,
      totalTokens: tokens,
      totalRequests: 1,
      lastUpdated: now,
    })
    .onConflictDoUpdate({
      target: [usageCounters.date, usageCounters.keyIndex, usageCounters.model],
      set: {
        totalTokens: sql`${usageCounters.totalTokens} + ${tokens}`,
        totalRequests: sql`${usageCounters.totalRequests} + 1`,
        lastUpdated: now,
      },
    });
}

/** All usage rows for a given day (per key × model). */
export async function getUsageForDay(db: DB, date: string): Promise<UsageRow[]> {
  return db
    .select()
    .from(usageCounters)
    .where(eq(usageCounters.date, date))
    .orderBy(asc(usageCounters.keyIndex), asc(usageCounters.model));
}

/** Usage rows for one key on a given day (per model). */
export async function getUsageForKey(db: DB, date: string, keyIndex: number): Promise<UsageRow[]> {
  return db
    .select()
    .from(usageCounters)
    .where(and(eq(usageCounters.date, date), eq(usageCounters.keyIndex, keyIndex)))
    .orderBy(asc(usageCounters.model));
}

// ── Tavily credit usage (monthly per key) ─────────────────────────────────────

export interface TavilyUsageRow {
  month: string;
  keyIndex: number;
  creditsUsed: number;
  searches: number;
  lastUpdated: number;
}

export async function addTavilyUsage(
  db: DB,
  month: string,
  keyIndex: number,
  credits: number,
): Promise<void> {
  log.info("addTavilyUsage", { month, keyIndex, credits });
  const now = Date.now();
  await db
    .insert(tavilyUsage)
    .values({ month, keyIndex, creditsUsed: credits, searches: 1, lastUpdated: now })
    .onConflictDoUpdate({
      target: [tavilyUsage.month, tavilyUsage.keyIndex],
      set: {
        creditsUsed: sql`${tavilyUsage.creditsUsed} + ${credits}`,
        searches: sql`${tavilyUsage.searches} + 1`,
        lastUpdated: now,
      },
    });
}

export async function getTavilyUsageForMonth(db: DB, month: string): Promise<TavilyUsageRow[]> {
  return db
    .select()
    .from(tavilyUsage)
    .where(eq(tavilyUsage.month, month))
    .orderBy(asc(tavilyUsage.keyIndex));
}

// ── Research tasks (async deep-research pipeline) ─────────────────────────────

export interface ResearchTaskRow {
  id: string;
  topic: string;
  status: string;
  stage: string;
  manuscript: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export async function createResearchTask(db: DB, id: string, topic: string): Promise<void> {
  log.info("createResearchTask", { id, topic: topic.slice(0, 80) });
  const now = Date.now();
  await db.insert(researchTasks).values({
    id,
    topic,
    status: "pending",
    stage: "Menyiapkan riset…",
    createdAt: now,
    updatedAt: now,
  });
}

export async function updateResearchTask(
  db: DB,
  id: string,
  patch: Partial<Pick<ResearchTaskRow, "status" | "stage" | "manuscript" | "error">>,
): Promise<void> {
  log.info("updateResearchTask", { id, status: patch.status, stage: patch.stage, hasManuscript: patch.manuscript != null, error: patch.error ?? undefined });
  await db
    .update(researchTasks)
    .set({ ...patch, updatedAt: Date.now() })
    .where(eq(researchTasks.id, id));
}

export async function getResearchTask(db: DB, id: string): Promise<ResearchTaskRow | null> {
  const row = await db.select().from(researchTasks).where(eq(researchTasks.id, id)).limit(1);
  return row[0] ?? null;
}
