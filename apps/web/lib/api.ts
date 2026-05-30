import type { Message, ModelUsage, ResearchTask, TavilyUsage, UsageResponse } from "./types";

// Client for the Hono Worker. The shared secret is kept in localStorage and sent
// as x-linda-secret on every request (single-owner app).

const API_BASE = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") || "http://localhost:8787";
const SECRET_KEY = "linda_secret";

export class UnauthorizedError extends Error {
  constructor() {
    super("Unauthorized");
    this.name = "UnauthorizedError";
  }
}

export function getSecret(): string {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(SECRET_KEY) ?? "";
}

export function setSecret(secret: string): void {
  window.localStorage.setItem(SECRET_KEY, secret);
}

export function clearSecret(): void {
  window.localStorage.removeItem(SECRET_KEY);
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "x-linda-secret": getSecret(),
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return (await res.json()) as T;
}

export async function sendChat(message: string): Promise<{ reply: string; keyUsed: string; model: string; timestamp: number }> {
  return req("/chat", { method: "POST", body: JSON.stringify({ message }) });
}

export async function fetchHistory(): Promise<Message[]> {
  const data = await req<{ messages: Message[] }>("/history");
  return data.messages;
}

export async function fetchUsage(): Promise<UsageResponse> {
  return req<UsageResponse>("/usage");
}

export async function fetchKeyDetail(index: number): Promise<ModelUsage[]> {
  const data = await req<{ keyIndex: number; models: ModelUsage[] }>(`/usage/${index}`);
  return data.models;
}

export async function fetchTavilyUsage(): Promise<TavilyUsage> {
  return req<TavilyUsage>("/usage/tavily");
}

// ── Deep research ─────────────────────────────────────────────────────────────

export async function startResearch(topic: string): Promise<{ id: string; status: string }> {
  return req("/research", { method: "POST", body: JSON.stringify({ topic }) });
}

export async function getResearch(id: string): Promise<ResearchTask> {
  return req<ResearchTask>(`/research/${id}`);
}

/** Verify a secret by hitting an authed endpoint; true if accepted. */
export async function verifySecret(secret: string): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/usage`, { headers: { "x-linda-secret": secret } });
    return res.ok;
  } catch {
    return false;
  }
}
