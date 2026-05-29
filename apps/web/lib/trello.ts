// Trello REST client (read + write). Auth via API key + token query params.
// Docs: https://developer.atlassian.com/cloud/trello/rest/

const BASE = "https://api.trello.com/1";

export function isTrelloConfigured(): boolean {
  return Boolean(process.env.TRELLO_API_KEY && process.env.TRELLO_TOKEN);
}

/**
 * The single board Linda is allowed to touch. When set, EVERY read/write is
 * scoped to it and any list/card outside it is rejected — the hard boundary.
 */
export function allowedBoardId(): string {
  const id = process.env.TRELLO_BOARD_ID;
  if (!id) throw new Error("TRELLO_BOARD_ID belum diset.");
  return id;
}

interface FetchOpts {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  params?: Record<string, string | number | boolean | undefined | null>;
}

async function trelloFetch<T>(path: string, opts: FetchOpts = {}): Promise<T> {
  const key = process.env.TRELLO_API_KEY;
  const token = process.env.TRELLO_TOKEN;
  if (!key || !token) throw new Error("Trello not configured (TRELLO_API_KEY/TRELLO_TOKEN).");

  const url = new URL(BASE + path);
  url.searchParams.set("key", key);
  url.searchParams.set("token", token);
  for (const [k, v] of Object.entries(opts.params ?? {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }

  const res = await fetch(url, { method: opts.method ?? "GET" });
  if (!res.ok) {
    throw new Error(`Trello ${opts.method ?? "GET"} ${path} -> ${res.status}: ${await res.text()}`);
  }
  // DELETE / some PUTs may return empty body.
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

// ── Types (trimmed to fields we request) ─────────────────────────────────────
export interface Board {
  id: string;
  name: string;
}
export interface List {
  id: string;
  name: string;
}
export interface Card {
  id: string;
  name: string;
  desc?: string;
  due: string | null;
  dueComplete?: boolean;
  idList?: string;
  idBoard?: string;
  url?: string;
}

// ── Boundary enforcement ─────────────────────────────────────────────────────
// Every list/card touched must belong to the allowed board, verified by asking
// Trello which board it lives on. This is enforced server-side regardless of
// what the model passes.

async function listBoardId(listId: string): Promise<string> {
  const l = await trelloFetch<{ idBoard: string }>(`/lists/${listId}`, {
    params: { fields: "idBoard" },
  });
  return l.idBoard;
}

async function assertListInBoard(listId: string): Promise<void> {
  if ((await listBoardId(listId)) !== allowedBoardId()) {
    throw new Error("List di luar board yang diizinkan — akses ditolak.");
  }
}

async function assertCardInBoard(cardId: string): Promise<void> {
  const c = await trelloFetch<{ idBoard: string }>(`/cards/${cardId}`, {
    params: { fields: "idBoard" },
  });
  if (c.idBoard !== allowedBoardId()) {
    throw new Error("Kartu di luar board yang diizinkan — akses ditolak.");
  }
}

// ── Reads (board-scoped) ──────────────────────────────────────────────────────
export function getBoard(): Promise<Board> {
  return trelloFetch<Board>(`/boards/${allowedBoardId()}`, { params: { fields: "name" } });
}

export function listLists(): Promise<List[]> {
  return trelloFetch<List[]>(`/boards/${allowedBoardId()}/lists`, { params: { fields: "name" } });
}

export function listCardsInBoard(): Promise<Card[]> {
  return trelloFetch<Card[]>(`/boards/${allowedBoardId()}/cards`, {
    params: { fields: "name,due,dueComplete,idList,idBoard,url" },
  });
}

export async function listCardsInList(listId: string): Promise<Card[]> {
  await assertListInBoard(listId);
  return trelloFetch<Card[]>(`/lists/${listId}/cards`, {
    params: { fields: "name,due,dueComplete,idList,idBoard,url" },
  });
}

export async function getCard(cardId: string): Promise<Card> {
  const card = await trelloFetch<Card>(`/cards/${cardId}`, {
    params: { fields: "name,desc,due,dueComplete,idList,idBoard,url" },
  });
  if (card.idBoard !== allowedBoardId()) {
    throw new Error("Kartu di luar board yang diizinkan — akses ditolak.");
  }
  return card;
}

export function searchCards(query: string): Promise<Card[]> {
  return trelloFetch<{ cards: Card[] }>("/search", {
    params: {
      query,
      modelTypes: "cards",
      idBoards: allowedBoardId(), // restrict search to the allowed board
      card_fields: "name,due,dueComplete,idList,idBoard,url",
      cards_limit: 15,
    },
  }).then((r) => r.cards ?? []);
}

// ── Name resolution (so the model works with names, not opaque IDs) ───────────
export async function findListByName(name: string): Promise<List> {
  const lists = await listLists();
  const lower = name.trim().toLowerCase();
  const exact = lists.find((l) => l.name.toLowerCase() === lower);
  if (exact) return exact;
  const partial = lists.filter((l) => l.name.toLowerCase().includes(lower));
  if (partial.length === 1) return partial[0];
  const names = lists.map((l) => l.name).join(", ");
  if (partial.length === 0) throw new Error(`List "${name}" tidak ada. List tersedia: ${names}`);
  throw new Error(`List "${name}" ambigu (${partial.map((l) => l.name).join(", ")}). Sebutkan lebih spesifik.`);
}

export async function firstList(): Promise<List> {
  const lists = await listLists();
  if (lists.length === 0) throw new Error("Board belum punya list.");
  return lists[0];
}

/** Find cards on the board by name (exact first, else substring). */
export async function findCardsByName(query: string): Promise<Card[]> {
  const cards = await listCardsInBoard();
  const lower = query.trim().toLowerCase();
  const exact = cards.filter((c) => c.name.toLowerCase() === lower);
  if (exact.length) return exact;
  return cards.filter((c) => c.name.toLowerCase().includes(lower));
}

/** Resolve a query to exactly one card, or throw a helpful disambiguation error. */
export async function resolveOneCard(query: string): Promise<Card> {
  const matches = await findCardsByName(query);
  if (matches.length === 0) throw new Error(`Kartu "${query}" tidak ditemukan di board.`);
  if (matches.length === 1) return matches[0];
  throw new Error(
    `Ada ${matches.length} kartu cocok: ${matches.map((c) => c.name).join(", ")}. Sebutkan lebih spesifik.`,
  );
}

// ── Writes (board-scoped) ─────────────────────────────────────────────────────
export async function createCard(input: {
  idList: string;
  name: string;
  desc?: string;
  due?: string;
}): Promise<Card> {
  await assertListInBoard(input.idList);
  return trelloFetch<Card>("/cards", {
    method: "POST",
    params: { idList: input.idList, name: input.name, desc: input.desc, due: input.due },
  });
}

export async function updateCard(
  cardId: string,
  fields: { name?: string; desc?: string; due?: string | null; dueComplete?: boolean; closed?: boolean },
): Promise<Card> {
  await assertCardInBoard(cardId);
  return trelloFetch<Card>(`/cards/${cardId}`, {
    method: "PUT",
    params: {
      name: fields.name,
      desc: fields.desc,
      // Pass empty string to clear a due date.
      due: fields.due === null ? "" : fields.due,
      dueComplete: fields.dueComplete,
      closed: fields.closed,
    },
  });
}

export async function moveCard(cardId: string, idList: string): Promise<Card> {
  await Promise.all([assertCardInBoard(cardId), assertListInBoard(idList)]);
  return trelloFetch<Card>(`/cards/${cardId}`, { method: "PUT", params: { idList } });
}

// ── Reminder helper (allowed board only) ──────────────────────────────────────
export interface DueCard extends Card {
  boardName: string;
  hoursLeft: number; // negative = overdue
}

/** Open, incomplete cards on the allowed board due within `hours` (incl. overdue). */
export async function getDueSoonCards(hours = 24): Promise<DueCard[]> {
  const [board, cards] = await Promise.all([getBoard(), listCardsInBoard()]);
  const now = Date.now();
  const horizon = now + hours * 3600_000;
  const out: DueCard[] = [];

  for (const c of cards) {
    if (!c.due || c.dueComplete) continue;
    const dueMs = new Date(c.due).getTime();
    if (Number.isNaN(dueMs)) continue;
    if (dueMs <= horizon) {
      out.push({ ...c, boardName: board.name, hoursLeft: (dueMs - now) / 3600_000 });
    }
  }
  return out.sort((a, b) => a.hoursLeft - b.hoursLeft);
}
