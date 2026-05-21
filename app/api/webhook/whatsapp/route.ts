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
} from "@/lib/redis";
import type { Message, Role } from "@/lib/types";

export const runtime = "nodejs"; // crypto + AI SDK need the Node runtime
export const maxDuration = 60;

const log = logger("whatsapp");

const RECENT_WINDOW = 20; // recent messages sent verbatim (ample token budget)
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
  const systemPrompt = buildContextPrompt(memories, summary);

  const assistantMessage: Message = { role: "assistant", content: "", timestamp: Date.now() };
  let reply: string;
  try {
    const result = await generateAIResponse(llmMessages, systemPrompt);
    reply = result.text.trim() || "Maaf, aku tidak punya jawaban untuk itu.";
    assistantMessage.keyUsed = result.keyUsed;
    void log.info("ai.ok", {
      phone: masked,
      keyUsed: result.keyUsed,
      tokens: result.tokensUsed,
      memories: memories.length,
      hasSummary: Boolean(summary),
      ms: Date.now() - startedAt,
    });
  } catch (err) {
    void log.error("ai.failed", { phone: masked, err: err instanceof Error ? err : String(err) });
    reply = "Maaf, sedang ada gangguan. Coba lagi sebentar lagi ya.";
    assistantMessage.keyUsed = "none";
  }

  assistantMessage.content = reply;
  assistantMessage.timestamp = Date.now();
  await saveChatMessage(phone, assistantMessage);

  // Reply to the user first; memory upkeep runs afterwards (still in background).
  await sendWhatsAppReply(phone, reply);
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

async function sendWhatsAppReply(phone: string, body: string): Promise<void> {
  const masked = maskPhone(phone);
  const phoneNumberId = process.env.WA_PHONE_NUMBER_ID;
  const accessToken = process.env.WA_ACCESS_TOKEN;
  if (!phoneNumberId || !accessToken) {
    void log.error("send.skipped", { reason: "WA_PHONE_NUMBER_ID or WA_ACCESS_TOKEN missing" });
    return;
  }

  try {
    const res = await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: phone,
        type: "text",
        text: { body },
      }),
    });
    if (!res.ok) {
      void log.error("send.failed", { phone: masked, status: res.status, body: await res.text() });
    } else {
      void log.info("send.ok", { phone: masked, status: res.status });
    }
  } catch (err) {
    void log.error("send.error", { phone: masked, err: err instanceof Error ? err : String(err) });
  }
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
