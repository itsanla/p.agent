import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { logger } from "./logger";
import * as trello from "./trello";

const log = logger("tools");

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
// of invoking it (e.g. "<function=trello_list_cards>{}</function>"). Strip such
// leaked tags from the final reply so the user never sees raw garbage.
const LEAK_RE = /<\/?function[^>]*>|<\|?(?:python_tag|tool_call)\|?>|\{"?name"?\s*:\s*"trello_[^}]*\}/gi;

export function stripLeakedToolCalls(text: string): string {
  return text.replace(LEAK_RE, "").replace(/\n{3,}/g, "\n\n").trim();
}

export function hasLeakedToolCall(text: string): boolean {
  return /<\/?function|<\|?(?:python_tag|tool_call)/i.test(text);
}

// Resolve a due date. Relative offsets (dueInDays/dueInHours) are computed in
// code — LLMs are unreliable at date arithmetic, so we never let the model do it.
function resolveDue(
  due: string | null | undefined,
  dueInDays?: number | null,
  dueInHours?: number | null,
): string | null | undefined {
  if (dueInDays != null || dueInHours != null) {
    const ms = Date.now() + (dueInDays ?? 0) * 86_400_000 + (dueInHours ?? 0) * 3_600_000;
    return new Date(ms).toISOString();
  }
  return due; // absolute ISO, null (clear), or undefined (leave unchanged)
}

const ok = (data: unknown) => ({ ok: true, data });
const fail = (err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : String(err) });

async function run<T>(name: string, fn: () => Promise<T>, input?: unknown) {
  void log.info(`${name}.call`, { input });
  try {
    const data = await fn();
    void log.info(`${name}.ok`);
    return ok(data);
  } catch (err) {
    void log.error(`${name}.failed`, { err: err instanceof Error ? err : String(err) });
    return fail(err);
  }
}

/** Build the Trello toolset. Only attach for the owner + when Trello is configured. */
export function buildTrelloTools(): ToolSet {
  return {
    trello_list_lists: tool({
      description: "Lihat semua kolom/list di board (mis. To Do, In Progress, Done).",
      inputSchema: z.object({}),
      execute: () => run("trello_list_lists", () => trello.listLists()),
    }),

    trello_list_cards: tool({
      description: "Lihat kartu di board. Beri nama list untuk membatasi ke satu kolom, atau kosongkan untuk semua kartu.",
      inputSchema: z.object({
        listName: z.string().optional().describe("nama kolom/list (opsional)"),
      }),
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
