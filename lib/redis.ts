import { Redis } from "@upstash/redis";
import type { ChatMetadata, Message } from "./types";

// Redis key structure:
//   chat:history:{phone}     → list of message JSON strings (max 50, newest pushed left)
//   chat:metadata:{phone}    → hash { lastActive, totalMessages, name, lastMessage }
//   chat:lastInbound:{phone} → ms timestamp of the latest INBOUND (user) message
//   chat:index               → set of all phone numbers with history
//   processed:msg:{id}       → dedup marker (24h TTL)
//   groq:stats:{index}:*     → token usage counters (see groq-manager)

const MAX_HISTORY = 50;

let client: Redis | null = null;

/** Lazily construct the Redis client so missing env vars fail loudly at call time, not import time. */
export function getRedis(): Redis {
  if (client) return client;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error(
      "Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN environment variables.",
    );
  }

  client = new Redis({ url, token });
  return client;
}

const historyKey = (phone: string) => `chat:history:${phone}`;
const metadataKey = (phone: string) => `chat:metadata:${phone}`;
const lastInboundKey = (phone: string) => `chat:lastInbound:${phone}`;
const INDEX_KEY = "chat:index";

/**
 * Record the timestamp (ms) of the latest INBOUND (user) message. This — not the
 * metadata `lastActive`, which also moves on our own replies — is what defines
 * WhatsApp's 24h customer-service window.
 */
export async function setLastInbound(phone: string, ts: number): Promise<void> {
  try {
    await getRedis().set(lastInboundKey(phone), ts);
  } catch (err) {
    console.error(`[redis] setLastInbound failed for ${phone}:`, err);
  }
}

/** Timestamp (ms) of the latest inbound user message, or null if unknown. */
export async function getLastInbound(phone: string): Promise<number | null> {
  try {
    const v = await getRedis().get<number>(lastInboundKey(phone));
    return v != null ? Number(v) : null;
  } catch (err) {
    console.error(`[redis] getLastInbound failed for ${phone}:`, err);
    return null;
  }
}

/** Return chat history in chronological order (oldest first). */
export async function getChatHistory(phone: string): Promise<Message[]> {
  try {
    const redis = getRedis();
    // Stored newest-first via LPUSH; reverse for chronological order.
    const raw = await redis.lrange<Message | string>(historyKey(phone), 0, MAX_HISTORY - 1);
    const messages = raw.map(parseMessage).filter((m): m is Message => m !== null);
    return messages.reverse();
  } catch (err) {
    console.error(`[redis] getChatHistory failed for ${phone}:`, err);
    return [];
  }
}

/** Append a message to history and update conversation metadata. */
export async function saveChatMessage(phone: string, message: Message): Promise<void> {
  try {
    const redis = getRedis();
    const pipeline = redis.multi();

    pipeline.lpush(historyKey(phone), JSON.stringify(message));
    pipeline.ltrim(historyKey(phone), 0, MAX_HISTORY - 1);
    pipeline.sadd(INDEX_KEY, phone);
    pipeline.hset(metadataKey(phone), {
      lastActive: message.timestamp,
      lastMessage: message.content.slice(0, 200),
    });
    pipeline.hincrby(metadataKey(phone), "totalMessages", 1);

    await pipeline.exec();
  } catch (err) {
    console.error(`[redis] saveChatMessage failed for ${phone}:`, err);
  }
}

export async function clearChatHistory(phone: string): Promise<void> {
  try {
    const redis = getRedis();
    const pipeline = redis.multi();
    pipeline.del(historyKey(phone));
    pipeline.del(metadataKey(phone));
    pipeline.srem(INDEX_KEY, phone);
    await pipeline.exec();
  } catch (err) {
    console.error(`[redis] clearChatHistory failed for ${phone}:`, err);
    throw err;
  }
}

/** Optionally set/update a display name for a conversation. */
export async function setChatName(phone: string, name: string): Promise<void> {
  try {
    await getRedis().hset(metadataKey(phone), { name });
  } catch (err) {
    console.error(`[redis] setChatName failed for ${phone}:`, err);
  }
}

/** List all active conversations, most recently active first. */
export async function getAllActiveChats(): Promise<ChatMetadata[]> {
  try {
    const redis = getRedis();
    const phones = await redis.smembers(INDEX_KEY);
    if (phones.length === 0) return [];

    const metas = await Promise.all(
      phones.map(async (phone) => {
        const meta = await redis.hgetall<Record<string, string | number>>(metadataKey(phone));
        if (!meta) return null;
        const chat: ChatMetadata = {
          phone,
          name: meta.name != null ? String(meta.name) : null,
          lastActive: Number(meta.lastActive ?? 0),
          totalMessages: Number(meta.totalMessages ?? 0),
          lastMessage: meta.lastMessage != null ? String(meta.lastMessage) : "",
        };
        return chat;
      }),
    );

    return metas
      .filter((m): m is ChatMetadata => m !== null)
      .sort((a, b) => b.lastActive - a.lastActive);
  } catch (err) {
    console.error("[redis] getAllActiveChats failed:", err);
    return [];
  }
}

/**
 * Atomically claim a message id for processing. Returns true if this is the
 * first time we've seen it (caller should process), false if already handled.
 */
export async function claimMessage(messageId: string): Promise<boolean> {
  try {
    const redis = getRedis();
    // NX = only set if absent; EX = 24h TTL. Returns "OK" when set, null otherwise.
    const result = await redis.set(`processed:msg:${messageId}`, "1", { nx: true, ex: 86400 });
    return result === "OK";
  } catch (err) {
    console.error(`[redis] claimMessage failed for ${messageId}:`, err);
    // Fail open: better to risk a duplicate reply than to drop the message.
    return true;
  }
}

// Upstash auto-deserializes JSON, so a stored object may come back as an object
// or as a string depending on how it was written. Handle both.
function parseMessage(value: Message | string): Message | null {
  try {
    if (typeof value === "string") return JSON.parse(value) as Message;
    return value;
  } catch {
    return null;
  }
}
