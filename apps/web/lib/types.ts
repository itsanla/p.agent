// View types shared by the chat + usage pages (mirror the Worker's responses).

export type Role = "user" | "assistant";

export interface Message {
  role: Role;
  content: string;
  timestamp: number;
  keyUsed?: string;
  modelUsed?: string;
}

export interface ModelUsage {
  model: string;
  totalTokens: number;
  totalRequests: number;
  tokenLimit: number;
  requestLimit: number;
}

export interface KeyUsage {
  index: number;
  maskedKey: string;
  restricted: boolean;
  isLimited: boolean;
  limitedUntil: string | null;
  totalTokens: number;
  totalRequests: number;
  combinedTokenLimit: number;
  lastUsed: string | null;
}

// ── Deep research (IEEE journal manuscript) ───────────────────────────────────
export interface Reference {
  n: number;
  ieee: string;
  doi: string;
}
export interface Manuscript {
  title: string;
  abstract: string;
  keywords: string[];
  sections: { heading: string; body: string }[];
  references: Reference[];
}
export interface ResearchTask {
  id: string;
  topic: string;
  status: "pending" | "running" | "done" | "error";
  stage: string;
  error: string | null;
  manuscript: Manuscript | null;
  updatedAt: number;
}

// ── Tavily credit usage ───────────────────────────────────────────────────────
export interface TavilyUsage {
  month: string;
  keys: { index: number; creditsUsed: number; limit: number; exhausted: boolean }[];
  combined: { totalKeys: number; creditsUsed: number; creditLimit: number };
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
