import { Index } from "@upstash/vector";

// Upstash Vector client for long-term semantic memory.
// The index must be created in the Upstash console with a hosted embedding
// model (BGE-M3, multilingual) so we can upsert/query raw text — no separate
// embedding API key or Groq tokens are needed.

let index: Index | null = null;
let warned = false;

export function isVectorConfigured(): boolean {
  return Boolean(process.env.UPSTASH_VECTOR_REST_URL && process.env.UPSTASH_VECTOR_REST_TOKEN);
}

/** Lazily build the Vector client. Returns null (with a one-time warning) when unconfigured. */
export function getVectorIndex(): Index | null {
  if (index) return index;
  const url = process.env.UPSTASH_VECTOR_REST_URL;
  const token = process.env.UPSTASH_VECTOR_REST_TOKEN;
  if (!url || !token) {
    if (!warned) {
      console.warn(
        "[vector] UPSTASH_VECTOR_REST_URL/TOKEN not set — long-term memory disabled.",
      );
      warned = true;
    }
    return null;
  }
  index = new Index({ url, token });
  return index;
}
