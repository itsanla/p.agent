import { randomUUID } from "crypto";
import { generateUtility } from "./groq-client";
import { getRedis } from "./redis";
import { getVectorIndex } from "./vector";
import { logger } from "./logger";
import type { Message } from "./types";

// Tiered long-term memory:
//   - Semantic facts in Upstash Vector, namespaced per phone (BGE-M3 embeds text).
//   - A rolling conversation summary in Redis (chat:summary:<phone>).
// Retrieval injects only the most relevant snippets, keeping token use low and
// letting the agent recall things said weeks ago without sending full history.

const log = logger("memory");

const TOP_K = 8; // retrieve more candidate memories (token budget is ample)
const MIN_RELEVANCE = 0.75; // ignore weakly-related memories (anti-hallucination)
const DEDUP_THRESHOLD = 0.9; // skip storing a fact this similar to an existing one
const MAX_FACTS = 8; // facts extracted per exchange

const summaryKey = (phone: string) => `chat:summary:${phone}`;

interface MemoryMetadata {
  phone: string;
  createdAt: number;
  kind: "fact";
  [key: string]: unknown;
}

// ── Retrieval ────────────────────────────────────────────────────────────────

/** Return up to TOP_K relevant past memories for `query`, above the relevance floor. */
export async function searchMemories(phone: string, query: string): Promise<string[]> {
  const index = getVectorIndex();
  if (!index || !query.trim()) return [];

  try {
    const results = await index.namespace(phone).query({
      data: query,
      topK: TOP_K,
      includeData: true,
      includeMetadata: true,
    });

    const memories = results
      .filter((r) => (r.score ?? 0) >= MIN_RELEVANCE)
      .map((r) => (typeof r.data === "string" ? r.data : null))
      .filter((d): d is string => Boolean(d));

    void log.info("memory.search", { phone: mask(phone), hits: memories.length, scanned: results.length });
    return memories;
  } catch (err) {
    void log.error("memory.search.failed", { phone: mask(phone), err: err instanceof Error ? err : String(err) });
    return [];
  }
}

// ── Storage / extraction ──────────────────────────────────────────────────────

const EXTRACT_SYSTEM = `Tugasmu: ekstrak fakta tahan-lama tentang pengguna dari percakapan untuk diingat di masa depan.
Nama, pekerjaan, preferensi/kesukaan, rencana, komitmen, dan detail pribadi penting SELALU dianggap fakta yang harus diekstrak.
Aturan keluaran:
- Balas HANYA dengan array JSON berisi string. Contoh: ["nama pengguna Anla","pekerjaan software developer","minuman favorit kopi susu"].
- JANGAN balas array kosong jika ada nama/pekerjaan/preferensi/rencana di percakapan.
- Balas [] hanya jika percakapan benar-benar tanpa info pribadi (mis. cuma sapaan atau pertanyaan umum).
- Setiap fakta ringkas, mandiri, fokus pada PENGGUNA (bukan asisten). Maksimal 8 fakta.`;

/** Extract durable facts from a recent exchange and store them (deduplicated) in Vector. */
export async function extractAndStoreMemories(phone: string, messages: Message[]): Promise<void> {
  const index = getVectorIndex();
  if (!index) return;

  const transcript = messages
    .map((m) => `${m.role === "user" ? "Pengguna" : "Asisten"}: ${m.content}`)
    .join("\n");
  if (!transcript.trim()) return;

  let facts: string[];
  try {
    const raw = await generateUtility(transcript, EXTRACT_SYSTEM);
    facts = parseFacts(raw);
  } catch (err) {
    void log.error("memory.extract.failed", { phone: mask(phone), err: err instanceof Error ? err : String(err) });
    return;
  }

  if (facts.length === 0) {
    void log.info("memory.extract.empty", { phone: mask(phone) });
    return;
  }

  const ns = index.namespace(phone);
  let stored = 0;
  for (const fact of facts) {
    try {
      // Dedup: skip if a near-identical memory already exists.
      const existing = await ns.query({ data: fact, topK: 1, includeMetadata: false });
      if (existing[0] && (existing[0].score ?? 0) >= DEDUP_THRESHOLD) continue;

      const meta: MemoryMetadata = { phone, createdAt: Date.now(), kind: "fact" };
      await ns.upsert({ id: `mem:${phone}:${randomUUID()}`, data: fact, metadata: meta });
      stored++;
    } catch (err) {
      void log.error("memory.store.failed", { phone: mask(phone), err: err instanceof Error ? err : String(err) });
    }
  }
  void log.info("memory.extract.ok", { phone: mask(phone), extracted: facts.length, stored });
}

// ── Rolling summary ─────────────────────────────────────────────────────────

export async function getSummary(phone: string): Promise<string> {
  try {
    const value = await getRedis().get<string>(summaryKey(phone));
    return value ?? "";
  } catch (err) {
    void log.error("memory.summary.read.failed", { phone: mask(phone), err: err instanceof Error ? err : String(err) });
    return "";
  }
}

const SUMMARY_SYSTEM = `Kamu meringkas percakapan WhatsApp jangka panjang. Gabungkan ringkasan lama dengan pesan terbaru menjadi satu ringkasan padat (maksimal 12 kalimat) yang menyimpan informasi penting, keputusan, komitmen, preferensi, dan konteks berkelanjutan. Pertahankan detail spesifik (nama, tanggal, angka) yang relevan. Tulis dalam bahasa Indonesia, naratif singkat, tanpa basa-basi.`;

/** Merge prior summary + recent messages into an updated rolling summary stored in Redis. */
export async function updateSummary(phone: string, recent: Message[], prevSummary: string): Promise<void> {
  const transcript = recent
    .map((m) => `${m.role === "user" ? "Pengguna" : "Asisten"}: ${m.content}`)
    .join("\n");
  if (!transcript.trim()) return;

  const prompt = `Ringkasan sebelumnya:\n${prevSummary || "(belum ada)"}\n\nPesan terbaru:\n${transcript}\n\nBuat ringkasan terbaru:`;
  try {
    const summary = (await generateUtility(prompt, SUMMARY_SYSTEM)).trim();
    if (summary) {
      await getRedis().set(summaryKey(phone), summary);
      void log.info("memory.summary.updated", { phone: mask(phone), chars: summary.length });
    }
  } catch (err) {
    void log.error("memory.summary.update.failed", { phone: mask(phone), err: err instanceof Error ? err : String(err) });
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

// Pull a JSON array of strings out of the model's reply, tolerating extra prose.
function parseFacts(raw: string): string[] {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return [];
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x): x is string => typeof x === "string")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .slice(0, MAX_FACTS);
  } catch {
    return [];
  }
}

function mask(phone: string): string {
  return phone.length > 4 ? `...${phone.slice(-4)}` : phone;
}
