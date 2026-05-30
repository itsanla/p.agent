// Groq model registry — mirrors ../../../../model.json. Used to compute per-model
// and per-key daily limits for the /usage page. Limits validated against live Groq
// rate-limit headers (see migration notes).

export interface ModelInfo {
  name: string;
  id: string;
  tokensPerDay: number;
  requestsPerDay: number;
  tokensPerMinute: number;
}

export const MODELS: ModelInfo[] = [
  { name: "Llama 3.1 8B", id: "llama-3.1-8b-instant", tokensPerDay: 500000, requestsPerDay: 14400, tokensPerMinute: 6000 },
  { name: "Llama 3.3 70B", id: "llama-3.3-70b-versatile", tokensPerDay: 100000, requestsPerDay: 1000, tokensPerMinute: 12000 },
  { name: "Llama 4 Scout 17B", id: "meta-llama/llama-4-scout-17b-16e-instruct", tokensPerDay: 500000, requestsPerDay: 1000, tokensPerMinute: 30000 },
  { name: "GPT OSS 120B", id: "openai/gpt-oss-120b", tokensPerDay: 200000, requestsPerDay: 1000, tokensPerMinute: 8000 },
  { name: "GPT OSS 20B", id: "openai/gpt-oss-20b", tokensPerDay: 200000, requestsPerDay: 1000, tokensPerMinute: 8000 },
  { name: "Safety GPT OSS 20B", id: "openai/gpt-oss-safeguard-20b", tokensPerDay: 200000, requestsPerDay: 1000, tokensPerMinute: 8000 },
];

const BY_ID = new Map(MODELS.map((m) => [m.id, m]));

export function modelInfo(id: string): ModelInfo | undefined {
  return BY_ID.get(id);
}

/** Sum of daily token limits across all registered models (per key). */
export const COMBINED_TPD_PER_KEY = MODELS.reduce((acc, m) => acc + m.tokensPerDay, 0);
