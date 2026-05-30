import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { logger } from "./logger";
import type { TavilyManager } from "./tavily";
import type { Trello } from "./trello";

const log = logger("tools");

// Guidance appended to Linda's system prompt when web search is available.
export const WEB_SEARCH_HINT = `

## Pencarian web (anti-halusinasi)
Kamu punya alat web_search dan web_extract. Gunakan web_search SECARA PROAKTIF — JANGAN menebak — bila pertanyaan:
- menyangkut informasi terkini/aktual (berita, harga, rilis, versi terbaru, kejadian),
- butuh fakta/angka/nama spesifik yang kamu tidak yakin 100% benar,
- bersifat teknis dan bisa berubah (versi pustaka, API, spesifikasi).
Untuk hal terkini set recency (day/week/month) dan/atau news=true. Untuk membaca isi sebuah URL spesifik (mis. pengguna mengirim tautan, atau ingin ringkasan artikel) pakai web_extract.
Setelah mencari: jawab ringkas berdasarkan hasil, dan sebutkan sumber singkat (nama situs/tautan). Jika hasil tidak memadai, katakan terus terang — jangan mengarang. Untuk sapaan, obrolan ringan, atau hitungan sederhana, JANGAN mencari.`;

// Guidance appended to Linda's system prompt when Trello tools are available.
export const TRELLO_SYSTEM_HINT = `

## Tugas Trello
Kamu terhubung ke satu papan Trello pengguna (papan akademik) dan dapat: melihat daftar kolom, melihat & membaca kartu, membuat kartu, memindahkan kartu antar kolom, serta mengedit/mengarsipkan kartu.

PENTING: Gunakan kemampuan itu dengan benar-benar menjalankan aksinya lewat alat yang tersedia. JANGAN PERNAH menuliskan nama fungsi, tag, atau sintaks pemanggilan (mis. teks bertanda kurung sudut) ke dalam balasanmu — cukup lakukan aksinya, lalu jawab pengguna dengan bahasa biasa.

Panduan:
- Rujuk kartu dan kolom dengan NAMA-nya apa adanya; sistem yang mencocokkan. Jangan memakai atau mengarang ID.
- Untuk pertanyaan umum seperti "ada apa saja di Trello", lihat dan rangkum kartu yang ada beserta kolomnya.
- Untuk deadline relatif, JANGAN menghitung tanggal sendiri (kamu sering salah). Pakai dueInDays/dueInHours: "besok"/"1 hari lagi"=dueInDays 1, "2 hari lagi"=dueInDays 2, "minggu depan"=dueInDays 7, "3 jam lagi"=dueInHours 3. Hanya pakai due (ISO) jika pengguna menyebut tanggal kalender spesifik (mis. "30 Mei jam 5 sore").
- Jika sebuah aksi gagal/ambigu/tidak ditemukan, sampaikan apa adanya ke pengguna dan minta klarifikasi singkat — jangan menebak.
- Setelah membuat/memindah/mengedit, konfirmasikan singkat (sebut nama kartu/kolom, bukan ID).`;

// Safety net: some models occasionally emit a tool call as literal text instead
// of invoking it. Strip such leaked tags from the final reply.
const LEAK_RE = /<\/?function[^>]*>|<\|?(?:python_tag|tool_call)\|?>|\{"?name"?\s*:\s*"trello_[^}]*\}/gi;

export function stripLeakedToolCalls(text: string): string {
  return text.replace(LEAK_RE, "").replace(/\n{3,}/g, "\n\n").trim();
}

export function hasLeakedToolCall(text: string): boolean {
  return /<\/?function|<\|?(?:python_tag|tool_call)/i.test(text);
}

// Relative offsets are computed in code — LLMs are unreliable at date arithmetic.
function resolveDue(
  due: string | null | undefined,
  dueInDays?: number | null,
  dueInHours?: number | null,
): string | null | undefined {
  if (dueInDays != null || dueInHours != null) {
    const ms = Date.now() + (dueInDays ?? 0) * 86_400_000 + (dueInHours ?? 0) * 3_600_000;
    return new Date(ms).toISOString();
  }
  return due;
}

const ok = (data: unknown) => ({ ok: true, data });
const fail = (err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : String(err) });

async function run<T>(name: string, fn: () => Promise<T>, input?: unknown) {
  log.info(`${name}.call`, { input });
  try {
    const data = await fn();
    log.info(`${name}.ok`);
    return ok(data);
  } catch (err) {
    log.error(`${name}.failed`, { err: err instanceof Error ? err : String(err) });
    return fail(err);
  }
}

/** Build the web toolset (search + extract) bound to a Tavily manager. */
export function buildWebTools(tavily: TavilyManager): ToolSet {
  return {
    web_search: tool({
      description:
        "Cari informasi terkini di web dan dapatkan jawaban tersintesis + sumber. Pakai untuk hal aktual/terbaru, fakta/angka spesifik, atau teknis yang tak pasti. Sertakan kata seperti 'hari ini'/'terbaru'/tahun di kueri bila relevan.",
      // Schema kept minimal (single string) — complex schemas (enum/array) make
      // Llama tool-calling on Groq emit malformed calls ("Failed to call a function").
      inputSchema: z.object({
        query: z.string().describe("kueri pencarian spesifik, boleh sertakan konteks waktu"),
      }),
      execute: ({ query }) =>
        run(
          "web_search",
          async () => {
            const r = await tavily.search(query, { searchDepth: "basic", includeAnswer: true, maxResults: 5 });
            return {
              answer: r.answer,
              sources: r.results.map((s) => ({ title: s.title, url: s.url, snippet: s.content.slice(0, 300) })),
            };
          },
          { query },
        ),
    }),

    web_extract: tool({
      description: "Ambil isi lengkap dari sebuah URL (mis. untuk meringkas artikel yang dikirim pengguna).",
      inputSchema: z.object({ url: z.string().describe("URL halaman yang ingin dibaca") }),
      execute: ({ url }) =>
        run(
          "web_extract",
          async () => {
            const r = await tavily.extract([url]);
            return r.map((x) => ({ url: x.url, content: x.rawContent.slice(0, 4000) }));
          },
          { url },
        ),
    }),
  };
}

/** Build the Trello toolset bound to a configured Trello client (owner only). */
export function buildTrelloTools(trello: Trello): ToolSet {
  return {
    trello_list_lists: tool({
      description: "Lihat semua kolom/list di board (mis. To Do, In Progress, Done).",
      inputSchema: z.object({}),
      execute: () => run("trello_list_lists", () => trello.listLists()),
    }),

    trello_list_cards: tool({
      description: "Lihat kartu di board. Beri nama list untuk membatasi ke satu kolom, atau kosongkan untuk semua kartu.",
      inputSchema: z.object({ listName: z.string().optional().describe("nama kolom/list (opsional)") }),
      execute: ({ listName }) =>
        run("trello_list_cards", async () => {
          if (listName) {
            const list = await trello.findListByName(listName);
            return trello.listCardsInList(list.id);
          }
          return trello.listCardsInBoard();
        }),
    }),

    trello_get_card: tool({
      description: "Baca detail satu kartu (deskripsi, due, kolom) berdasarkan namanya.",
      inputSchema: z.object({ cardName: z.string().describe("nama/judul kartu") }),
      execute: ({ cardName }) =>
        run("trello_get_card", async () => {
          const card = await trello.resolveOneCard(cardName);
          return trello.getCard(card.id);
        }),
    }),

    trello_create_card: tool({
      description:
        "Buat kartu baru. Untuk deadline relatif (mis. 'besok', '2 hari lagi', '3 jam lagi') pakai dueInDays/dueInHours — JANGAN hitung tanggal sendiri. Pakai due (ISO) hanya untuk tanggal kalender spesifik.",
      inputSchema: z.object({
        name: z.string().describe("judul kartu"),
        listName: z.string().optional().describe("nama kolom tujuan (opsional)"),
        desc: z.string().optional().describe("deskripsi"),
        dueInDays: z.number().optional().describe("deadline N hari dari sekarang (mis. besok=1)"),
        dueInHours: z.number().optional().describe("deadline N jam dari sekarang"),
        due: z.string().optional().describe("deadline tanggal kalender spesifik (ISO 8601)"),
      }),
      execute: ({ name, listName, desc, due, dueInDays, dueInHours }) =>
        run(
          "trello_create_card",
          async () => {
            const list = listName ? await trello.findListByName(listName) : await trello.firstList();
            const resolvedDue = resolveDue(due, dueInDays, dueInHours) ?? undefined;
            return trello.createCard({ idList: list.id, name, desc, due: resolvedDue });
          },
          { name, listName, desc, due, dueInDays, dueInHours },
        ),
    }),

    trello_update_card: tool({
      description:
        "Edit kartu (berdasarkan nama): ubah judul, deskripsi, deadline, tandai selesai (dueComplete), atau arsipkan (closed). Untuk deadline relatif pakai dueInDays/dueInHours — JANGAN hitung tanggal sendiri.",
      inputSchema: z.object({
        cardName: z.string().describe("nama kartu yang akan diedit"),
        name: z.string().optional().describe("judul baru"),
        desc: z.string().optional(),
        dueInDays: z.number().optional().describe("deadline baru N hari dari sekarang"),
        dueInHours: z.number().optional().describe("deadline baru N jam dari sekarang"),
        due: z.string().nullable().optional().describe("deadline tanggal kalender (ISO), atau null untuk menghapus"),
        dueComplete: z.boolean().optional(),
        closed: z.boolean().optional().describe("true untuk mengarsipkan kartu"),
      }),
      execute: ({ cardName, dueInDays, dueInHours, ...fields }) =>
        run(
          "trello_update_card",
          async () => {
            const card = await trello.resolveOneCard(cardName);
            const due = resolveDue(fields.due, dueInDays, dueInHours);
            return trello.updateCard(card.id, { ...fields, due });
          },
          { cardName, dueInDays, dueInHours, ...fields },
        ),
    }),

    trello_move_card: tool({
      description: "Pindahkan kartu (berdasarkan nama) ke kolom/list lain (berdasarkan nama).",
      inputSchema: z.object({
        cardName: z.string().describe("nama kartu yang dipindah"),
        toListName: z.string().describe("nama kolom tujuan"),
      }),
      execute: ({ cardName, toListName }) =>
        run("trello_move_card", async () => {
          const [card, list] = await Promise.all([
            trello.resolveOneCard(cardName),
            trello.findListByName(toListName),
          ]);
          return trello.moveCard(card.id, list.id);
        }),
    }),
  };
}
