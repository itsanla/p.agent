import type { Ctx } from "./context";
import { setSummary } from "./db";
import { logger } from "./logger";
import { maskPhone } from "./format";
import { storeFacts } from "./vector";
import type { Message } from "./types";

const log = logger("memory");

const MAX_FACTS = 8;

/** Run the cheap/fast utility model (memory tasks) with key-only failover. */
async function generateUtility(ctx: Ctx, prompt: string, system: string): Promise<string> {
  const result = await ctx.groq.generate([{ role: "user", content: prompt }], {
    systemPrompt: system,
    model: ctx.groq.utilityModel,
    temperature: 0,
  });
  return result.text;
}

const EXTRACT_SYSTEM = `Tugasmu: ekstrak fakta tahan-lama tentang pengguna dari percakapan untuk diingat di masa depan.
Nama, pekerjaan, preferensi/kesukaan, rencana, komitmen, dan detail pribadi penting SELALU dianggap fakta yang harus diekstrak.
Aturan keluaran:
- Balas HANYA dengan array JSON berisi string. Contoh: ["nama pengguna Anla","pekerjaan software developer","minuman favorit kopi susu"].
- JANGAN balas array kosong jika ada nama/pekerjaan/preferensi/rencana di percakapan.
- Balas [] hanya jika percakapan benar-benar tanpa info pribadi (mis. cuma sapaan atau pertanyaan umum).
- Setiap fakta ringkas, mandiri, fokus pada PENGGUNA (bukan asisten). Maksimal 8 fakta.`;

/** Extract durable facts from a recent exchange and store them (deduplicated). */
export async function extractAndStoreMemories(ctx: Ctx, phone: string, messages: Message[]): Promise<void> {
  const transcript = messages
    .map((m) => `${m.role === "user" ? "Pengguna" : "Asisten"}: ${m.content}`)
    .join("\n");
  if (!transcript.trim()) return;

  let facts: string[];
  try {
    facts = parseFacts(await generateUtility(ctx, transcript, EXTRACT_SYSTEM));
  } catch (err) {
    log.error("extract.failed", { phone: maskPhone(phone), err: err instanceof Error ? err : String(err) });
    return;
  }
  if (facts.length === 0) {
    log.info("extract.empty", { phone: maskPhone(phone) });
    return;
  }
  await storeFacts(ctx, phone, facts);
}

const SUMMARY_SYSTEM = `Kamu meringkas percakapan jangka panjang. Gabungkan ringkasan lama dengan pesan terbaru menjadi satu ringkasan padat (maksimal 12 kalimat) yang menyimpan informasi penting, keputusan, komitmen, preferensi, dan konteks berkelanjutan. Pertahankan detail spesifik (nama, tanggal, angka) yang relevan. Tulis dalam bahasa Indonesia, naratif singkat, tanpa basa-basi.`;

/** Merge prior summary + recent messages into an updated rolling summary (stored in D1). */
export async function updateSummary(ctx: Ctx, phone: string, recent: Message[], prevSummary: string): Promise<void> {
  const transcript = recent
    .map((m) => `${m.role === "user" ? "Pengguna" : "Asisten"}: ${m.content}`)
    .join("\n");
  if (!transcript.trim()) return;

  const prompt = `Ringkasan sebelumnya:\n${prevSummary || "(belum ada)"}\n\nPesan terbaru:\n${transcript}\n\nBuat ringkasan terbaru:`;
  try {
    const summary = (await generateUtility(ctx, prompt, SUMMARY_SYSTEM)).trim();
    if (summary) {
      await setSummary(ctx.db, phone, summary);
      log.info("summary.updated", { phone: maskPhone(phone), chars: summary.length });
    }
  } catch (err) {
    log.error("summary.update.failed", { phone: maskPhone(phone), err: err instanceof Error ? err : String(err) });
  }
}

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
