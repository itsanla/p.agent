import type { Ctx } from "./context";
import { getChatHistory, saveChatMessage, setLastInbound } from "./db";
import { maskPhone } from "./format";
import { logger } from "./logger";
import { extractAndStoreMemories, updateSummary } from "./memory";
import { getSummary } from "./db";
import { isOwner } from "./owner";
import { buildContextPrompt } from "./system-prompt";
import {
  buildTrelloTools,
  buildWebTools,
  hasLeakedToolCall,
  stripLeakedToolCalls,
  TRELLO_SYSTEM_HINT,
  WEB_SEARCH_HINT,
} from "./tools";
import { isTrelloConfigured, Trello } from "./trello";
import type { ToolSet } from "ai";
import { searchMemories } from "./vector";
import type { Message, Role } from "./types";

const log = logger("agent");

const RECENT_WINDOW = 12; // recent messages verbatim (summary + memory cover the rest)
const SUMMARY_EVERY = 12; // refresh the rolling summary every N messages

export interface ReplyResult {
  reply: string;
  keyUsed: string;
  modelUsed: string;
  userMessage: Message;
  assistantMessage: Message;
  historyLen: number;
}

/** Read recent history, preferring the Redis cache and falling back to D1. */
async function loadHistory(ctx: Ctx, phone: string): Promise<Message[]> {
  const cached = await ctx.cache.getHistory(phone);
  if (cached) return cached;
  const hist = await getChatHistory(ctx.db, phone, 50);
  await ctx.cache.setHistory(phone, hist);
  return hist;
}

/**
 * Core turn: persist the user message, retrieve context, generate Linda's reply,
 * persist it, and return everything needed for background memory upkeep.
 * Channel-agnostic — used by both the WhatsApp webhook and the web /chat endpoint.
 */
export async function generateReply(ctx: Ctx, phone: string, text: string): Promise<ReplyResult> {
  const masked = maskPhone(phone);
  const startedAt = Date.now();
  log.info("process.start", { phone: masked });

  const userMessage: Message = { role: "user", content: text, timestamp: startedAt };
  await saveChatMessage(ctx.db, phone, userMessage);
  await setLastInbound(ctx.db, phone, startedAt);
  await ctx.cache.invalidateHistory(phone);

  const [memories, summary, history] = await Promise.all([
    searchMemories(ctx, phone, text),
    getSummary(ctx.db, phone),
    loadHistory(ctx, phone),
  ]);

  const recent = history.slice(-RECENT_WINDOW);
  const llmMessages: { role: Role; content: string }[] = recent.map((m) => ({ role: m.role, content: m.content }));

  // Tools (web search + Trello) only for the owner. Web search is the anti-
  // hallucination path; Trello is action-taking. Both gated to the single owner.
  const owner = isOwner(ctx.env, phone);
  const webEnabled = owner && ctx.tavily.configured;
  const trelloEnabled = owner && isTrelloConfigured(ctx.env);

  let systemPrompt = buildContextPrompt(ctx.env, memories, summary);
  let tools: ToolSet | undefined;
  if (webEnabled || trelloEnabled) {
    tools = {
      ...(webEnabled ? buildWebTools(ctx.tavily) : {}),
      ...(trelloEnabled ? buildTrelloTools(new Trello(ctx.env)) : {}),
    };
    if (webEnabled) systemPrompt += WEB_SEARCH_HINT;
    if (trelloEnabled) systemPrompt += TRELLO_SYSTEM_HINT;
  }
  const toolsEnabled = tools !== undefined;

  const optEnv = ctx.env as unknown as Record<string, string | undefined>;
  const chatTemp = Number(optEnv.GROQ_CHAT_TEMPERATURE ?? 0.6);
  const toolTemp = Number(optEnv.GROQ_TOOL_TEMPERATURE ?? 0.2);

  const assistantMessage: Message = { role: "assistant", content: "", timestamp: Date.now() };
  let reply: string;
  let keyUsed = "none";
  let modelUsed = ctx.groq.chatModel;
  try {
    const result = await ctx.groq.generate(llmMessages, {
      systemPrompt,
      temperature: toolsEnabled ? toolTemp : chatTemp,
      tools,
      maxSteps: 4,
    });
    const leaked = hasLeakedToolCall(result.text);
    reply = stripLeakedToolCalls(result.text) || "Maaf, aku belum berhasil memprosesnya. Coba ulangi permintaanmu ya.";
    keyUsed = result.keyUsed;
    modelUsed = result.modelUsed;
    assistantMessage.keyUsed = result.keyUsed;
    assistantMessage.modelUsed = result.modelUsed;
    log.info("ai.ok", {
      phone: masked,
      keyUsed: result.keyUsed,
      model: result.modelUsed,
      tokens: result.tokensUsed,
      memories: memories.length,
      tools: toolsEnabled,
      leaked,
      ms: Date.now() - startedAt,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error("ai.failed", { phone: masked, err: errMsg });
    reply = friendlyError(errMsg);
  }

  assistantMessage.content = reply;
  assistantMessage.timestamp = Date.now();
  await saveChatMessage(ctx.db, phone, assistantMessage);
  await ctx.cache.invalidateHistory(phone);

  return { reply, keyUsed, modelUsed, userMessage, assistantMessage, historyLen: history.length + 1 };
}

/** Background upkeep: extract durable facts and periodically refresh the summary. */
export async function runUpkeep(
  ctx: Ctx,
  phone: string,
  userMessage: Message,
  assistantMessage: Message,
  totalMessages: number,
): Promise<void> {
  try {
    await extractAndStoreMemories(ctx, phone, [userMessage, assistantMessage]);
    if (totalMessages > RECENT_WINDOW && totalMessages % SUMMARY_EVERY === 0) {
      const [history, prev] = await Promise.all([getChatHistory(ctx.db, phone, 50), getSummary(ctx.db, phone)]);
      await updateSummary(ctx, phone, history.slice(-SUMMARY_EVERY), prev);
    }
  } catch (err) {
    log.error("upkeep.failed", { phone: maskPhone(phone), err: err instanceof Error ? err : String(err) });
  }
}

// Turn an internal error into a clear user-facing message.
function friendlyError(msg: string): string {
  if (/rate limit|tokens per day|\bTPD\b|requests per day|\bRPD\b|restricted/i.test(msg)) {
    const raw = msg.match(/try again in ([0-9hms.]+)/i)?.[1];
    const when = raw ? ` Coba lagi sekitar ${formatRetry(raw)} lagi ya.` : " Coba lagi nanti ya.";
    return `Maaf, kuota AI harian sudah habis.${when}`;
  }
  return "Maaf, sedang ada gangguan. Coba lagi sebentar lagi ya.";
}

function formatRetry(raw: string): string {
  const h = Number(raw.match(/(\d+)h/)?.[1] ?? 0);
  const m = Number(raw.match(/(\d+)m/)?.[1] ?? 0);
  const s = Number(raw.match(/(\d+(?:\.\d+)?)s/)?.[1] ?? 0);
  if (h > 0) return `${h} jam${m ? ` ${m} menit` : ""}`;
  const mins = m + (s > 0 ? 1 : 0);
  return mins > 0 ? `± ${mins} menit` : `${Math.round(s)} detik`;
}
