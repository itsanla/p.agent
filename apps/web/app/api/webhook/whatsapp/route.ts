import { createHmac, timingSafeEqual } from "crypto";
import { NextRequest } from "next/server";
import { after } from "next/server";
import { generateAIResponse } from "@/lib/groq-client";
import { maskPhone } from "@/lib/format";
import { logger } from "@/lib/logger";
import {
  extractAndStoreMemories,
  getSummary,
  searchMemories,
  updateSummary,
} from "@/lib/memory";
import { buildContextPrompt } from "@/lib/system-prompt";
import {
  claimMessage,
  getChatHistory,
  saveChatMessage,
  setChatName,
  setLastInbound,
} from "@/lib/redis";
import {
  buildTrelloTools,
  hasLeakedToolCall,
  stripLeakedToolCalls,
  TRELLO_SYSTEM_HINT,
} from "@/lib/tools";
import { isTrelloConfigured } from "@/lib/trello";
import { sendWhatsAppMessage } from "@/lib/whatsapp";
import { isOwner } from "@/lib/owner";
import type { Message, Role } from "@/lib/types";

export const runtime = "nodejs"; // crypto + AI SDK need the Node runtime
export const maxDuration = 60;

const log = logger("whatsapp");

const RECENT_WINDOW = 12; // recent messages verbatim (summary + memory cover the rest)
const SUMMARY_EVERY = 12; // refresh the rolling summary every N messages

// ── GET: Meta webhook verification ──────────────────────────────────────────
export async function GET(req: NextRequest): Promise<Response> {
  const params = req.nextUrl.searchParams;
  const mode = params.get("hub.mode");
  const token = params.get("hub.verify_token");
  const challenge = params.get("hub.challenge");

  if (mode === "subscribe" && token === process.env.WEBHOOK_VERIFY_TOKEN && challenge) {
    void log.info("webhook.verify.ok", { mode });
    return new Response(challenge, { status: 200 });
  }
  void log.warn("webhook.verify.failed", {
    mode,
    tokenMatch: token === process.env.WEBHOOK_VERIFY_TOKEN,
    hasChallenge: Boolean(challenge),
  });
  return new Response("Forbidden", { status: 403 });
}

// ── POST: receive & process inbound messages ────────────────────────────────
export async function POST(req: NextRequest): Promise<Response> {
  // Body must be read once, as raw text, to verify the signature.
  const rawBody = await req.text();
  const signature = req.headers.get("x-hub-signature-256");

  void log.info("webhook.received", { bytes: rawBody.length, hasSignature: Boolean(signature) });

  if (!verifySignature(rawBody, signature)) {
    void log.error("webhook.signature.invalid", { hasSignature: Boolean(signature) });
    return new Response("Invalid signature", { status: 403 });
  }
  void log.info("webhook.signature.ok");

  let payload: WhatsAppWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as WhatsAppWebhookPayload;
  } catch (err) {
    void log.error("webhook.parse.failed", { err: err instanceof Error ? err : String(err) });
    return new Response("Bad Request", { status: 400 });
  }

  const incoming = extractTextMessage(payload);

  if (!incoming) {
    void log.info("webhook.ignored", { reason: "no text message in payload" });
  }

  // Always 200 fast so Meta doesn't retry. Heavy work runs after the response.
  if (incoming) {
    const masked = maskPhone(incoming.phone);
    void log.info("message.accepted", {
      phone: masked,
      messageId: incoming.messageId,
      chars: incoming.messageText.length,
    });
    after(async () => {
      try {
        const first = await claimMessage(incoming.messageId);
        if (!first) {
          void log.info("message.duplicate", { phone: masked, messageId: incoming.messageId });
          return; // duplicate delivery, already handled
        }
        if (incoming.name) await setChatName(incoming.phone, incoming.name);
        await processMessage(incoming.phone, incoming.messageText);
      } catch (err) {
        void log.error("message.processing.failed", {
          phone: masked,
          messageId: incoming.messageId,
          err: err instanceof Error ? err : String(err),
        });
      }
    });
  }

  return new Response("OK", { status: 200 });
}

async function processMessage(phone: string, messageText: string): Promise<void> {
  const masked = maskPhone(phone);
  const startedAt = Date.now();
  void log.info("process.start", { phone: masked });

  const userMessage: Message = { role: "user", content: messageText, timestamp: startedAt };
  await saveChatMessage(phone, userMessage);
  // Record the inbound time so proactive notifications can pick WhatsApp vs Slack.
  await setLastInbound(phone, startedAt);

  // Retrieve long-term memory + rolling summary (Vector + Redis, no Groq tokens).
  const [memories, summary, history] = await Promise.all([
    searchMemories(phone, messageText),
    getSummary(phone),
    getChatHistory(phone),
  ]);

  // Only the recent window goes verbatim; older context comes via summary/memories.
  const recent = history.slice(-RECENT_WINDOW);
  const llmMessages: { role: Role; content: string }[] = recent.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  // Action tools (Trello) are attached only for the owner, and only when configured.
  const toolsEnabled = isOwner(phone) && isTrelloConfigured();
  let systemPrompt = buildContextPrompt(memories, summary);
  if (toolsEnabled) systemPrompt += TRELLO_SYSTEM_HINT;
  const tools = toolsEnabled ? buildTrelloTools() : undefined;

  const assistantMessage: Message = { role: "assistant", content: "", timestamp: Date.now() };
  let reply: string;
  try {
    const result = await generateAIResponse(llmMessages, systemPrompt, tools);
    const leaked = hasLeakedToolCall(result.text);
    reply =
      stripLeakedToolCalls(result.text) ||
      "Maaf, aku belum berhasil memprosesnya. Coba ulangi permintaanmu ya.";
    if (leaked) void log.warn("ai.tool_leak", { phone: masked });
    assistantMessage.keyUsed = result.keyUsed;
    void log.info("ai.ok", {
      phone: masked,
      keyUsed: result.keyUsed,
      tokens: result.tokensUsed,
      memories: memories.length,
      hasSummary: Boolean(summary),
      tools: toolsEnabled,
      leaked,
      ms: Date.now() - startedAt,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    void log.error("ai.failed", { phone: masked, err: errMsg });
    reply = friendlyError(errMsg);
    assistantMessage.keyUsed = "none";
  }

  assistantMessage.content = reply;
  assistantMessage.timestamp = Date.now();
  await saveChatMessage(phone, assistantMessage);

  // Reply to the user first; memory upkeep runs afterwards (still in background).
  await sendWhatsAppMessage(phone, reply);
  void log.info("process.done", { phone: masked, ms: Date.now() - startedAt });

  await updateMemory(phone, userMessage, assistantMessage, history.length + 1);
}

// Extract durable facts, and periodically refresh the rolling summary.
async function updateMemory(
  phone: string,
  userMessage: Message,
  assistantMessage: Message,
  totalMessages: number,
): Promise<void> {
  try {
    await extractAndStoreMemories(phone, [userMessage, assistantMessage]);
    // Refresh summary every SUMMARY_EVERY messages once the conversation is long enough.
    if (totalMessages > RECENT_WINDOW && totalMessages % SUMMARY_EVERY === 0) {
      const [history, prev] = await Promise.all([getChatHistory(phone), getSummary(phone)]);
      await updateSummary(phone, history.slice(-SUMMARY_EVERY), prev);
    }
  } catch (err) {
    void log.error("memory.upkeep.failed", {
      phone: maskPhone(phone),
      err: err instanceof Error ? err : String(err),
    });
  }
}

// Turn an internal error into a clear user-facing message.
function friendlyError(msg: string): string {
  if (/rate limit|tokens per day|\bTPD\b|requests per day|\bRPD\b/i.test(msg)) {
    const raw = msg.match(/try again in ([0-9hms.]+)/i)?.[1];
    const when = raw ? ` Coba lagi sekitar ${formatRetry(raw)} lagi ya.` : " Coba lagi nanti ya.";
    return `Maaf, kuota AI harian sudah habis.${when}`;
  }
  return "Maaf, sedang ada gangguan. Coba lagi sebentar lagi ya.";
}

// "36m19.87s" → "± 37 menit", "1h2m3s" → "1 jam 2 menit", "45s" → "± 1 menit".
function formatRetry(raw: string): string {
  const h = Number(raw.match(/(\d+)h/)?.[1] ?? 0);
  const m = Number(raw.match(/(\d+)m/)?.[1] ?? 0);
  const s = Number(raw.match(/(\d+(?:\.\d+)?)s/)?.[1] ?? 0);
  if (h > 0) return `${h} jam${m ? ` ${m} menit` : ""}`;
  const mins = m + (s > 0 ? 1 : 0); // round seconds up to a minute
  return mins > 0 ? `± ${mins} menit` : `${Math.round(s)} detik`;
}

// Validate x-hub-signature-256 (HMAC-SHA256 of the raw body with the app secret).
function verifySignature(rawBody: string, signature: string | null): boolean {
  const appSecret = process.env.WA_APP_SECRET;
  if (!appSecret) {
    void log.error("webhook.signature.no-secret", { reason: "WA_APP_SECRET not set" });
    return false;
  }
  if (!signature || !signature.startsWith("sha256=")) return false;

  const expected = "sha256=" + createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

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

    const name = value?.contacts?.[0]?.profile?.name ?? null;
    return {
      phone: message.from,
      messageText: message.text.body,
      messageId: message.id,
      name,
    };
  } catch {
    return null;
  }
}

// ── Minimal typing of the WhatsApp Cloud API webhook payload ─────────────────
interface WhatsAppWebhookPayload {
  entry?: {
    changes?: {
      value?: {
        contacts?: { profile?: { name?: string } }[];
        messages?: {
          from: string;
          id: string;
          type: string;
          text?: { body: string };
        }[];
      };
    }[];
  }[];
}
