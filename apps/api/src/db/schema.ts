import { int, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

// D1 is the source of truth. Upstash Redis only caches hot reads on top of this.
// All timestamps are epoch milliseconds (int).

// ── Chat history (source of truth; Redis caches the recent window) ────────────
export const messages = sqliteTable("messages", {
  id: int().primaryKey({ autoIncrement: true }),
  phone: text().notNull(),
  role: text().notNull(), // "user" | "assistant"
  content: text().notNull(),
  keyUsed: text("key_used"), // Groq key index that produced an assistant message
  modelUsed: text("model_used"),
  createdAt: int("created_at").notNull(),
});

// ── Conversation metadata (one row per phone) ─────────────────────────────────
export const conversations = sqliteTable("conversations", {
  phone: text().primaryKey(),
  name: text(),
  lastActive: int("last_active").notNull().default(0),
  totalMessages: int("total_messages").notNull().default(0),
  lastMessage: text("last_message").notNull().default(""),
  // ms timestamp of the latest INBOUND (user) message — defines WhatsApp's 24h window.
  lastInbound: int("last_inbound"),
});

// ── Rolling conversation summary (was Redis chat:summary) ─────────────────────
export const summaries = sqliteTable("summaries", {
  phone: text().primaryKey(),
  summary: text().notNull().default(""),
  updatedAt: int("updated_at").notNull(),
});

// ── Long-term memory facts (mirror of Vectorize entries; id == vector id) ─────
export const memoryFacts = sqliteTable("memory_facts", {
  id: text().primaryKey(), // also the Vectorize vector id
  phone: text().notNull(),
  fact: text().notNull(),
  createdAt: int("created_at").notNull(),
});

// ── Tavily credit usage, per (month, key) — Tavily credits reset monthly ──────
export const tavilyUsage = sqliteTable(
  "tavily_usage",
  {
    month: text().notNull(), // YYYY-MM (UTC)
    keyIndex: int("key_index").notNull(),
    creditsUsed: int("credits_used").notNull().default(0),
    searches: int().notNull().default(0),
    lastUpdated: int("last_updated").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.month, t.keyIndex] })],
);

// ── Deep-research tasks (async journal pipeline, web-only) ────────────────────
export const researchTasks = sqliteTable("research_tasks", {
  id: text().primaryKey(), // uuid
  topic: text().notNull(),
  status: text().notNull().default("pending"), // pending|running|done|error
  stage: text().notNull().default(""), // human-readable progress label
  manuscript: text(), // JSON: { title, abstract, keywords, sections[], references[] }
  error: text(),
  createdAt: int("created_at").notNull(),
  updatedAt: int("updated_at").notNull(),
});

// ── Groq usage counters, per (day, key, model) — source of truth for /usage ───
export const usageCounters = sqliteTable(
  "usage_counters",
  {
    date: text().notNull(), // YYYY-MM-DD (UTC)
    keyIndex: int("key_index").notNull(),
    model: text().notNull(),
    totalTokens: int("total_tokens").notNull().default(0),
    totalRequests: int("total_requests").notNull().default(0),
    lastUpdated: int("last_updated").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.date, t.keyIndex, t.model] })],
);
