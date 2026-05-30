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

export type StreamEvent =
  | { type: "delta"; text: string }
  | { type: "search"; query: string }
  | { type: "sources"; count: number; sources: { title: string; url: string }[] };

/**
 * Streaming variant of a turn: emits text deltas + web-search progress events as
 * Linda works (Claude/Grok-style search UI). Returns the same result shape so the
 * caller can run background memory upkeep.
 */
export async function streamReply(
  ctx: Ctx,
  phone: string,
  text: string,
  emit: (ev: StreamEvent) => void | Promise<void>,
): Promise<ReplyResult> {
  const masked = maskPhone(phone);
  const startedAt = Date.now();
  log.info("stream.start", { phone: masked });

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

  const owner = isOwner(ctx.env, phone);
  const webEnabled = owner && ctx.tavily.configured;
  const trelloEnabled = owner && isTrelloConfigured(ctx.env);
  const baseSystem = buildContextPrompt(ctx.env, memories, summary);
  const optEnv = ctx.env as unknown as Record<string, string | undefined>;

  const assistantMessage: Message = { role: "assistant", content: "", timestamp: Date.now() };
  let reply: string;
  let keyUsed = "none";
  let modelUsed = ctx.groq.chatModel;
  try {
    // ── Phase A: run tools (reliably) via generateText, capture results ──
    // Tools can't stream on Groq/Llama (they leak as text), so we execute them
    // first (no final answer yet), emit search progress, and collect tool output.
    // Skip entirely for casual chat so the answer streams immediately (no ~5s gate).
    let toolContext = "";
    if ((webEnabled || trelloEnabled) && needsTools(text)) {
      const tools: ToolSet = {
        ...(webEnabled ? buildWebTools(ctx.tavily) : {}),
        ...(trelloEnabled ? buildTrelloTools(new Trello(ctx.env)) : {}),
      };
      let phaseASystem = baseSystem;
      if (webEnabled) phaseASystem += WEB_SEARCH_HINT;
      if (trelloEnabled) phaseASystem += TRELLO_SYSTEM_HINT;
      try {
        await ctx.groq.generate(llmMessages, {
          systemPrompt: phaseASystem,
          model: ctx.groq.utilityModel, // fast 8B as the tool-gate to minimize latency
          temperature: Number(optEnv.GROQ_TOOL_TEMPERATURE ?? 0.2),
          tools,
          maxSteps: 1, // stop after the tool call(s) — don't write the answer yet
          // Tiny budget: we only need the tool call (small); a direct answer here
          // is discarded, so keep this cheap to minimize latency before streaming.
          maxOutputTokens: 96,
          onStepFinish: async (step) => {
            const s = step as {
              toolCalls?: { toolName: string; input?: { query?: string }; args?: { query?: string } }[];
              toolResults?: { toolName: string; output?: unknown; result?: unknown }[];
            };
            for (const tc of s.toolCalls ?? []) {
              if (tc.toolName === "web_search") {
                const query = (tc.input ?? tc.args)?.query ?? "";
                log.info("stream.search", { phone: masked, query: query.slice(0, 80) });
                await emit({ type: "search", query });
              }
            }
            for (const tr of s.toolResults ?? []) {
              const out = (tr.output ?? tr.result) as { data?: unknown } | undefined;
              if (tr.toolName === "web_search") {
                const data = out?.data as { answer?: string; sources?: { title: string; url: string }[] } | undefined;
                const sources = data?.sources ?? [];
                log.info("stream.sources", { phone: masked, count: sources.length });
                await emit({ type: "sources", count: sources.length, sources: sources.slice(0, 8) });
                toolContext += `\n[Pencarian web] ${data?.answer ?? ""}\nSumber: ${sources.map((x) => x.title + " — " + x.url).join("; ")}\n`;
              } else {
                toolContext += `\n[${tr.toolName}] ${safeJson(out?.data ?? out)}\n`;
              }
            }
          },
        });
      } catch (err) {
        // Tool phase failed — proceed to stream an answer without tool context.
        log.warn("stream.toolphase.failed", { phone: masked, err: err instanceof Error ? err.message : String(err) });
      }
    }

    // ── Phase B: stream the final answer token-by-token (no tools → no leak) ──
    let phaseBSystem = baseSystem;
    if (toolContext.trim()) {
      phaseBSystem +=
        `\n\n## Hasil alat/pencarian web (gunakan untuk menjawab)\n${toolContext}\n` +
        `Jawab pengguna berdasarkan hasil di atas. Sebutkan angka/fakta spesifik dan sumber bila relevan. Jangan menulis sintaks pemanggilan fungsi.`;
    }
    let fullText = "";
    const result = await ctx.groq.streamComplete(
      llmMessages,
      { systemPrompt: phaseBSystem, temperature: Number(optEnv.GROQ_CHAT_TEMPERATURE ?? 0.6), maxOutputTokens: 2048 },
      async (chunk) => {
        fullText += chunk;
        await emit({ type: "delta", text: chunk });
      },
    );
    reply = stripLeakedToolCalls(result.text || fullText) || "Maaf, aku belum berhasil memprosesnya. Coba ulangi permintaanmu ya.";
    keyUsed = result.keyUsed;
    modelUsed = result.modelUsed;
    assistantMessage.keyUsed = result.keyUsed;
    assistantMessage.modelUsed = result.modelUsed;
    log.info("stream.ai.ok", { phone: masked, keyUsed, model: modelUsed, tokens: result.tokensUsed, searched: Boolean(toolContext), ms: Date.now() - startedAt });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error("stream.ai.failed", { phone: masked, err: errMsg });
    reply = friendlyError(errMsg);
    await emit({ type: "delta", text: reply });
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

// Heuristic: does this message likely need web search or Trello tools? Used to
// skip the (latency-adding) tool-gate for casual chat so it streams instantly.
function needsTools(text: string): boolean {
  return (
    /\b(cari|carikan|search|googling|telusuri|browsing|berita|kabar terbaru|harga|kurs|saham|crypto|bitcoin|skor|cuaca|terbaru|terkini|sekarang|hari ini|barusan|update|rilis|jadwal|trello|kartu|tugas|deadline|to-?do|board|pindahkan)\b/i.test(
      text,
    ) || /https?:\/\/|www\./i.test(text)
  );
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v).slice(0, 1500);
  } catch {
    return String(v);
  }
}

function formatRetry(raw: string): string {
  const h = Number(raw.match(/(\d+)h/)?.[1] ?? 0);
  const m = Number(raw.match(/(\d+)m/)?.[1] ?? 0);
  const s = Number(raw.match(/(\d+(?:\.\d+)?)s/)?.[1] ?? 0);
  if (h > 0) return `${h} jam${m ? ` ${m} menit` : ""}`;
  const mins = m + (s > 0 ? 1 : 0);
  return mins > 0 ? `± ${mins} menit` : `${Math.round(s)} detik`;
}
