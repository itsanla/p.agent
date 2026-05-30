import { Hono } from "hono";
import { cors } from "hono/cors";
import { generateReply, runUpkeep } from "./lib/agent";
import { buildCtx } from "./lib/context";
import { createResearchTask, getChatHistory, getResearchTask, setChatName } from "./lib/db";
import { runResearch } from "./lib/research";
import { maskPhone } from "./lib/format";
import { logger } from "./lib/logger";
import { isTrelloConfigured, Trello, type DueCard } from "./lib/trello";
import { buildUsage, buildKeyDetail } from "./lib/usage";
import { sendWhatsAppMessage } from "./lib/whatsapp";
import { requireSecret } from "./middleware/auth";

const log = logger("http");

const app = new Hono<{ Bindings: Env }>();

app.use(
  "*",
  cors({
    origin: (origin) => origin ?? "*", // single-owner app; secret gate is the real guard
    allowHeaders: ["Content-Type", "x-linda-secret"],
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
  }),
);

app.get("/", (c) => c.json({ ok: true, service: "linda-api" }));

// ── WhatsApp webhook ──────────────────────────────────────────────────────────

app.get("/webhook/whatsapp", (c) => {
  const mode = c.req.query("hub.mode");
  const token = c.req.query("hub.verify_token");
  const challenge = c.req.query("hub.challenge");
  if (mode === "subscribe" && token === c.env.WEBHOOK_VERIFY_TOKEN && challenge) {
    log.info("webhook.verify.ok");
    return c.text(challenge, 200);
  }
  log.warn("webhook.verify.failed", { tokenMatch: token === c.env.WEBHOOK_VERIFY_TOKEN });
  return c.text("Forbidden", 403);
});

app.post("/webhook/whatsapp", async (c) => {
  const rawBody = await c.req.text();
  const signature = c.req.header("x-hub-signature-256") ?? null;

  if (!(await verifySignature(c.env.WA_APP_SECRET, rawBody, signature))) {
    log.error("webhook.signature.invalid", { hasSignature: Boolean(signature) });
    return c.text("Invalid signature", 403);
  }

  let payload: WhatsAppWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as WhatsAppWebhookPayload;
  } catch {
    return c.text("Bad Request", 400);
  }

  const incoming = extractTextMessage(payload);
  if (incoming) {
    const ctx = buildCtx(c.env);
    const masked = maskPhone(incoming.phone);
    log.info("message.accepted", { phone: masked, messageId: incoming.messageId });
    // 200 fast; heavy work runs in the background.
    c.executionCtx.waitUntil(
      (async () => {
        try {
          if (!(await ctx.cache.claimMessage(incoming.messageId))) {
            log.info("message.duplicate", { phone: masked });
            return;
          }
          if (incoming.name) await setChatName(ctx.db, incoming.phone, incoming.name);
          const result = await generateReply(ctx, incoming.phone, incoming.messageText);
          await sendWhatsAppMessage(c.env, incoming.phone, result.reply);
          await runUpkeep(ctx, incoming.phone, result.userMessage, result.assistantMessage, result.historyLen);
        } catch (err) {
          log.error("message.processing.failed", { phone: masked, err: err instanceof Error ? err : String(err) });
        }
      })(),
    );
  }

  return c.text("OK", 200);
});

// ── Web chat (owner identity, shared memory) ──────────────────────────────────

app.post("/chat", requireSecret, async (c) => {
  const phone = c.env.OWNER_PHONE;
  if (!phone) return c.json({ error: "OWNER_PHONE not configured" }, 500);

  let body: { message?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const message = (body.message ?? "").trim();
  if (!message) return c.json({ error: "Empty message" }, 400);

  const ctx = buildCtx(c.env);
  const result = await generateReply(ctx, phone, message);
  // Memory upkeep runs after we return the reply.
  c.executionCtx.waitUntil(
    runUpkeep(ctx, phone, result.userMessage, result.assistantMessage, result.historyLen),
  );

  return c.json({
    reply: result.reply,
    keyUsed: result.keyUsed,
    model: result.modelUsed,
    timestamp: result.assistantMessage.timestamp,
  });
});

app.get("/history", requireSecret, async (c) => {
  const phone = c.env.OWNER_PHONE;
  if (!phone) return c.json({ error: "OWNER_PHONE not configured" }, 500);
  const ctx = buildCtx(c.env);
  const history = await getChatHistory(ctx.db, phone, 50);
  return c.json({ messages: history });
});

// ── Usage ─────────────────────────────────────────────────────────────────────

app.get("/usage", requireSecret, async (c) => {
  const ctx = buildCtx(c.env);
  return c.json(await buildUsage(ctx));
});

// Tavily credit usage (monthly per key). Registered BEFORE /usage/:keyIndex.
app.get("/usage/tavily", requireSecret, async (c) => {
  const ctx = buildCtx(c.env);
  const keys = await ctx.tavily.getUsageStates();
  return c.json({
    month: new Date().toISOString().slice(0, 7),
    keys,
    combined: {
      totalKeys: keys.length,
      creditsUsed: keys.reduce((a, k) => a + k.creditsUsed, 0),
      creditLimit: keys.reduce((a, k) => a + k.limit, 0),
    },
  });
});

app.get("/usage/:keyIndex", requireSecret, async (c) => {
  const keyIndex = Number(c.req.param("keyIndex"));
  if (!Number.isInteger(keyIndex)) return c.json({ error: "Invalid key index" }, 400);
  const ctx = buildCtx(c.env);
  return c.json({ keyIndex, models: await buildKeyDetail(ctx, keyIndex) });
});

// ── Deep research (web-only "deep search" mode → IEEE journal manuscript) ──────

app.post("/research", requireSecret, async (c) => {
  let body: { topic?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const topic = (body.topic ?? "").trim();
  if (!topic) return c.json({ error: "Empty topic" }, 400);

  const ctx = buildCtx(c.env);
  // OpenAlex/Crossref work without Tavily; only web-context enrichment needs it.
  if (!ctx.tavily.configured) log.warn("research.no-tavily");
  const id = crypto.randomUUID();
  await createResearchTask(ctx.db, id, topic);
  c.executionCtx.waitUntil(runResearch(ctx, id, topic));
  log.info("research.start", { id, topic: topic.slice(0, 60) });
  return c.json({ id, status: "pending" });
});

app.get("/research/:id", requireSecret, async (c) => {
  const ctx = buildCtx(c.env);
  const task = await getResearchTask(ctx.db, c.req.param("id"));
  if (!task) return c.json({ error: "Not found" }, 404);
  return c.json({
    id: task.id,
    topic: task.topic,
    status: task.status,
    stage: task.stage,
    error: task.error,
    manuscript: task.manuscript ? JSON.parse(task.manuscript) : null,
    updatedAt: task.updatedAt,
  });
});

// ── Scheduled: Trello reminder (replaces Vercel/GitHub cron) ───────────────────

async function runTrelloReminder(env: Env): Promise<void> {
  const owner = env.OWNER_PHONE;
  if (!owner) return log.error("cron.skip", { reason: "OWNER_PHONE not set" });
  if (!isTrelloConfigured(env)) return log.error("cron.skip", { reason: "Trello not configured" });

  const ctx = buildCtx(env);
  const trello = new Trello(env);
  try {
    const due = await trello.getDueSoonCards(24);
    const fresh: DueCard[] = [];
    for (const card of due) {
      if (await ctx.cache.claimReminder(`${card.id}:${card.due}`)) fresh.push(card);
    }
    if (fresh.length > 0) await sendWhatsAppMessage(env, owner, formatReminder(fresh));
    log.info("cron.run", { dueSoon: due.length, notified: fresh.length });
  } catch (err) {
    log.error("cron.failed", { err: err instanceof Error ? err : String(err) });
  }
}

function formatReminder(cards: DueCard[]): string {
  const lines = cards.map((c) => {
    const when = c.hoursLeft < 0 ? `⚠️ TERLEWAT ${fmtDur(-c.hoursLeft)} lalu` : `⏰ ${fmtDur(c.hoursLeft)} lagi`;
    return `• ${c.name} (${c.boardName}) — ${when}`;
  });
  const head =
    cards.length === 1
      ? "Halo! Ada 1 tugas Trello yang mendekati deadline:"
      : `Halo! Ada ${cards.length} tugas Trello yang mendekati deadline:`;
  return `${head}\n\n${lines.join("\n")}`;
}

function fmtDur(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)} menit`;
  if (hours < 24) return `${Math.round(hours)} jam`;
  return `${Math.round(hours / 24)} hari`;
}

// ── WhatsApp signature (HMAC-SHA256 via WebCrypto) ────────────────────────────

async function verifySignature(appSecret: string | undefined, rawBody: string, signature: string | null): Promise<boolean> {
  if (!appSecret) {
    log.error("webhook.signature.no-secret");
    return false;
  }
  if (!signature || !signature.startsWith("sha256=")) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(appSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(rawBody));
  const expected = "sha256=" + [...new Uint8Array(sigBuf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return timingSafeEqual(signature, expected);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ── WhatsApp payload typing ────────────────────────────────────────────────────

interface ExtractedMessage {
  phone: string;
  messageText: string;
  messageId: string;
  name: string | null;
}

function extractTextMessage(payload: WhatsAppWebhookPayload): ExtractedMessage | null {
  try {
    const value = payload.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];
    if (!message || message.type !== "text" || !message.text?.body) return null;
    return {
      phone: message.from,
      messageText: message.text.body,
      messageId: message.id,
      name: value?.contacts?.[0]?.profile?.name ?? null,
    };
  } catch {
    return null;
  }
}

interface WhatsAppWebhookPayload {
  entry?: {
    changes?: {
      value?: {
        contacts?: { profile?: { name?: string } }[];
        messages?: { from: string; id: string; type: string; text?: { body: string } }[];
      };
    }[];
  }[];
}

export default {
  fetch: app.fetch,
  scheduled: async (_event: ScheduledController, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(runTrelloReminder(env));
  },
};
