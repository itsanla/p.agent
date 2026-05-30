// Trello REST client (read + write). Auth via API key + token query params.
// Scoped to a single allowed board — every read/write is verified against it.
// Docs: https://developer.atlassian.com/cloud/trello/rest/

const BASE = "https://api.trello.com/1";

export interface TrelloEnv {
  TRELLO_API_KEY?: string;
  TRELLO_TOKEN?: string;
  TRELLO_BOARD_ID?: string;
}

export function isTrelloConfigured(env: TrelloEnv): boolean {
  return Boolean(env.TRELLO_API_KEY && env.TRELLO_TOKEN && env.TRELLO_BOARD_ID);
}

interface FetchOpts {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  params?: Record<string, string | number | boolean | undefined | null>;
}

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

export interface DueCard extends Card {
  boardName: string;
  hoursLeft: number; // negative = overdue
}

export class Trello {
  private key: string;
  private token: string;
  private boardId: string;

  constructor(env: TrelloEnv) {
    if (!env.TRELLO_API_KEY || !env.TRELLO_TOKEN || !env.TRELLO_BOARD_ID) {
      throw new Error("Trello not configured (TRELLO_API_KEY/TRELLO_TOKEN/TRELLO_BOARD_ID).");
    }
    this.key = env.TRELLO_API_KEY;
    this.token = env.TRELLO_TOKEN;
    this.boardId = env.TRELLO_BOARD_ID;
  }

  private async fetch<T>(path: string, opts: FetchOpts = {}): Promise<T> {
    const url = new URL(BASE + path);
    url.searchParams.set("key", this.key);
    url.searchParams.set("token", this.token);
    for (const [k, v] of Object.entries(opts.params ?? {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const res = await fetch(url, { method: opts.method ?? "GET" });
    if (!res.ok) {
      throw new Error(`Trello ${opts.method ?? "GET"} ${path} -> ${res.status}: ${await res.text()}`);
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : null) as T;
  }

  // ── Boundary enforcement ────────────────────────────────────────────────────
  private async assertListInBoard(listId: string): Promise<void> {
    const l = await this.fetch<{ idBoard: string }>(`/lists/${listId}`, { params: { fields: "idBoard" } });
    if (l.idBoard !== this.boardId) throw new Error("List di luar board yang diizinkan — akses ditolak.");
  }

  private async assertCardInBoard(cardId: string): Promise<void> {
    const c = await this.fetch<{ idBoard: string }>(`/cards/${cardId}`, { params: { fields: "idBoard" } });
    if (c.idBoard !== this.boardId) throw new Error("Kartu di luar board yang diizinkan — akses ditolak.");
  }

  // ── Reads (board-scoped) ──────────────────────────────────────────────────────
  getBoard(): Promise<Board> {
    return this.fetch<Board>(`/boards/${this.boardId}`, { params: { fields: "name" } });
  }

  listLists(): Promise<List[]> {
    return this.fetch<List[]>(`/boards/${this.boardId}/lists`, { params: { fields: "name" } });
  }

  listCardsInBoard(): Promise<Card[]> {
    return this.fetch<Card[]>(`/boards/${this.boardId}/cards`, {
      params: { fields: "name,due,dueComplete,idList,idBoard,url" },
    });
  }

  async listCardsInList(listId: string): Promise<Card[]> {
    await this.assertListInBoard(listId);
    return this.fetch<Card[]>(`/lists/${listId}/cards`, {
      params: { fields: "name,due,dueComplete,idList,idBoard,url" },
    });
  }

  async getCard(cardId: string): Promise<Card> {
    const card = await this.fetch<Card>(`/cards/${cardId}`, {
      params: { fields: "name,desc,due,dueComplete,idList,idBoard,url" },
    });
    if (card.idBoard !== this.boardId) throw new Error("Kartu di luar board yang diizinkan — akses ditolak.");
    return card;
  }

  // ── Name resolution ───────────────────────────────────────────────────────────
  async findListByName(name: string): Promise<List> {
    const lists = await this.listLists();
    const lower = name.trim().toLowerCase();
    const exact = lists.find((l) => l.name.toLowerCase() === lower);
    if (exact) return exact;
    const partial = lists.filter((l) => l.name.toLowerCase().includes(lower));
    if (partial.length === 1) return partial[0];
    const names = lists.map((l) => l.name).join(", ");
    if (partial.length === 0) throw new Error(`List "${name}" tidak ada. List tersedia: ${names}`);
    throw new Error(`List "${name}" ambigu (${partial.map((l) => l.name).join(", ")}). Sebutkan lebih spesifik.`);
  }

  async firstList(): Promise<List> {
    const lists = await this.listLists();
    if (lists.length === 0) throw new Error("Board belum punya list.");
    return lists[0];
  }

  async findCardsByName(query: string): Promise<Card[]> {
    const cards = await this.listCardsInBoard();
    const lower = query.trim().toLowerCase();
    const exact = cards.filter((c) => c.name.toLowerCase() === lower);
    if (exact.length) return exact;
    return cards.filter((c) => c.name.toLowerCase().includes(lower));
  }

  async resolveOneCard(query: string): Promise<Card> {
    const matches = await this.findCardsByName(query);
    if (matches.length === 0) throw new Error(`Kartu "${query}" tidak ditemukan di board.`);
    if (matches.length === 1) return matches[0];
    throw new Error(
      `Ada ${matches.length} kartu cocok: ${matches.map((c) => c.name).join(", ")}. Sebutkan lebih spesifik.`,
    );
  }

  // ── Writes (board-scoped) ─────────────────────────────────────────────────────
  async createCard(input: { idList: string; name: string; desc?: string; due?: string }): Promise<Card> {
    await this.assertListInBoard(input.idList);
    return this.fetch<Card>("/cards", {
      method: "POST",
      params: { idList: input.idList, name: input.name, desc: input.desc, due: input.due },
    });
  }

  async updateCard(
    cardId: string,
    fields: { name?: string; desc?: string; due?: string | null; dueComplete?: boolean; closed?: boolean },
  ): Promise<Card> {
    await this.assertCardInBoard(cardId);
    return this.fetch<Card>(`/cards/${cardId}`, {
      method: "PUT",
      params: {
        name: fields.name,
        desc: fields.desc,
        due: fields.due === null ? "" : fields.due, // empty string clears the due date
        dueComplete: fields.dueComplete,
        closed: fields.closed,
      },
    });
  }

  async moveCard(cardId: string, idList: string): Promise<Card> {
    await Promise.all([this.assertCardInBoard(cardId), this.assertListInBoard(idList)]);
    return this.fetch<Card>(`/cards/${cardId}`, { method: "PUT", params: { idList } });
  }

  // ── Reminder helper ─────────────────────────────────────────────────────────
  /** Open, incomplete cards on the allowed board due within `hours` (incl. overdue). */
  async getDueSoonCards(hours = 24): Promise<DueCard[]> {
    const [board, cards] = await Promise.all([this.getBoard(), this.listCardsInBoard()]);
    const now = Date.now();
    const horizon = now + hours * 3600_000;
    const out: DueCard[] = [];
    for (const c of cards) {
      if (!c.due || c.dueComplete) continue;
      const dueMs = new Date(c.due).getTime();
      if (Number.isNaN(dueMs)) continue;
      if (dueMs <= horizon) out.push({ ...c, boardName: board.name, hoursLeft: (dueMs - now) / 3600_000 });
    }
    return out.sort((a, b) => a.hoursLeft - b.hoursLeft);
  }
}
