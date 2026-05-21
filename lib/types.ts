// Shared domain types used across the app.

export type Role = "user" | "assistant";

export interface Message {
  role: Role;
  content: string;
  timestamp: number;
  /** Groq API key index that produced this message (assistant only). */
  keyUsed?: string;
}

export interface ChatMetadata {
  phone: string;
  name: string | null;
  lastActive: number;
  totalMessages: number;
  lastMessage: string;
}

/** Live + persisted state for a single Groq API key. */
export interface KeyState {
  index: number;
  maskedKey: string;
  limitRequests: number | null;
  limitTokens: number | null;
  remainingRequests: number | null;
  remainingTokens: number | null;
  resetRequestsAt: number | null; // epoch ms
  resetTokensAt: number | null; // epoch ms
  isLimited: boolean;
  limitedUntil: number | null; // epoch ms
  totalTokensUsed: number;
  totalRequestsMade: number;
  lastUsed: number | null; // epoch ms
}

/** Shape returned by GET /api/stats for a single key. */
export interface KeyStatsResponse {
  index: number;
  maskedKey: string;
  isLimited: boolean;
  limitedUntil: string | null;
  remainingTokens: number | null;
  limitTokens: number | null;
  remainingRequests: number | null;
  limitRequests: number | null;
  resetTokensIn: number | null; // ms from now
  resetRequestsIn: number | null; // ms from now
  totalTokensUsed: number;
  totalRequestsMade: number;
  lastUsed: string | null;
}

export interface CombinedStatsResponse {
  totalKeys: number;
  activeKeys: number;
  limitedKeys: number;
  totalRemainingTokens: number;
  totalLimitTokens: number;
  totalRemainingRequests: number;
  totalRequestsToday: number;
}

export interface StatsResponse {
  keys: KeyStatsResponse[];
  combined: CombinedStatsResponse;
  updatedAt: string;
}
