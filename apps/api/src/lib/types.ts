// Shared domain types used across the Worker.

export type Role = "user" | "assistant";

export interface Message {
  role: Role;
  content: string;
  timestamp: number;
  /** Groq API key index that produced this message (assistant only). */
  keyUsed?: string;
  /** Groq model that produced this message (assistant only). */
  modelUsed?: string;
}

export interface ChatMetadata {
  phone: string;
  name: string | null;
  lastActive: number;
  totalMessages: number;
  lastMessage: string;
}

/** Live rate-limit state for a single Groq API key (cached in Redis). */
export interface KeyState {
  index: number;
  maskedKey: string;
  /** True when the key's org is restricted (403) — disabled for the session. */
  restricted: boolean;
  limitRequests: number | null;
  limitTokens: number | null;
  remainingRequests: number | null;
  remainingTokens: number | null;
  resetRequestsAt: number | null; // epoch ms
  resetTokensAt: number | null; // epoch ms
  isLimited: boolean;
  limitedUntil: number | null; // epoch ms
  lastUsed: number | null; // epoch ms
}

// ── /usage response shapes ────────────────────────────────────────────────────

/** Per-model usage breakdown for one key (shown on the "Detail" drilldown). */
export interface ModelUsage {
  model: string;
  totalTokens: number;
  totalRequests: number;
  /** Daily token limit (TPD) for this model from model.json. */
  tokenLimit: number;
  requestLimit: number;
}

/** Aggregated usage for one key (sum across all models) — the default /usage row. */
export interface KeyUsage {
  index: number;
  maskedKey: string;
  restricted: boolean;
  isLimited: boolean;
  limitedUntil: string | null;
  totalTokens: number; // summed across models today
  totalRequests: number;
  /** Sum of per-model daily token limits across the 6 models. */
  combinedTokenLimit: number;
  lastUsed: string | null;
}

export interface UsageResponse {
  keys: KeyUsage[];
  combined: {
    totalKeys: number;
    activeKeys: number;
    restrictedKeys: number;
    limitedKeys: number;
    totalTokensToday: number;
    totalRequestsToday: number;
    combinedDailyTokenLimit: number;
  };
  updatedAt: string;
}
