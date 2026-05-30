import type { Ctx } from "./context";
import { factExists, recordFact } from "./db";
import { logger } from "./logger";
import { maskPhone } from "./format";

// Long-term semantic memory backed by Cloudflare Vectorize. Embeddings are
// generated on the edge with Workers AI (@cf/baai/bge-m3 → 1024-dim, multilingual)
// — Vectorize does not host embeddings. Facts are namespaced per phone and mirrored
// in D1 (memory_facts) as the source of truth.

const log = logger("vector");

const EMBED_MODEL = "@cf/baai/bge-m3";
const TOP_K = 6; // relevant memories to inject
// Calibrated for bge-m3 cosine on Workers AI: relevant matches score ~0.65, noise
// ~0.35–0.45, so 0.55 cleanly separates them (Upstash's hosted BGE-M3 scored higher).
const MIN_RELEVANCE = 0.55;
const DEDUP_THRESHOLD = 0.9; // skip storing a fact this semantically similar to an existing one

interface FactMeta {
  phone: string;
  text: string;
  createdAt: number;
  kind: "fact";
  [key: string]: VectorizeVectorMetadataValue;
}

/** Embed one or more texts to 1024-dim vectors via Workers AI bge-m3. */
export async function embed(env: Env, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const res = (await env.AI.run(EMBED_MODEL as keyof AiModels, { text: texts })) as {
    data?: number[][];
    response?: { data?: number[][] } | number[][];
  };
  const data =
    res.data ??
    (Array.isArray(res.response) ? res.response : res.response?.data) ??
    [];
  return data;
}

/** Return up to TOP_K relevant past memories for `query`, above the relevance floor. */
export async function searchMemories(ctx: Ctx, phone: string, query: string): Promise<string[]> {
  if (!query.trim()) return [];
  try {
    const [vector] = await embed(ctx.env, [query]);
    if (!vector) return [];
    const result = await ctx.env.VECTORIZE.query(vector, {
      topK: TOP_K,
      namespace: phone,
      returnMetadata: "all",
      returnValues: false,
    });
    const scores = (result.matches ?? []).map((m) => Math.round((m.score ?? 0) * 1000) / 1000);
    const memories = (result.matches ?? [])
      .filter((m) => (m.score ?? 0) >= MIN_RELEVANCE)
      .map((m) => (m.metadata as FactMeta | undefined)?.text)
      .filter((t): t is string => Boolean(t));
    log.info("search", { phone: maskPhone(phone), hits: memories.length, scanned: result.matches?.length ?? 0, scores: JSON.stringify(scores) });
    return memories;
  } catch (err) {
    log.error("search.failed", { phone: maskPhone(phone), err: err instanceof Error ? err : String(err) });
    return [];
  }
}

/** Embed, dedup, upsert facts into Vectorize (per-phone namespace) + mirror in D1. */
export async function storeFacts(ctx: Ctx, phone: string, facts: string[]): Promise<number> {
  if (facts.length === 0) return 0;
  let stored = 0;
  try {
    const vectors = await embed(ctx.env, facts);
    for (let i = 0; i < facts.length; i++) {
      const fact = facts[i];
      const values = vectors[i];
      if (!values) continue;
      // Exact-text dedup via D1 first (strongly consistent — closes Vectorize's
      // eventual-consistency gap where back-to-back stores miss recent upserts).
      if (await factExists(ctx.db, phone, fact)) continue;
      // Semantic dedup: skip if a near-identical memory already exists in this namespace.
      const existing = await ctx.env.VECTORIZE.query(values, {
        topK: 1,
        namespace: phone,
        returnValues: false,
        returnMetadata: "none",
      });
      if ((existing.matches?.[0]?.score ?? 0) >= DEDUP_THRESHOLD) continue;

      const id = `mem:${phone}:${crypto.randomUUID()}`;
      const metadata: FactMeta = { phone, text: fact, createdAt: Date.now(), kind: "fact" };
      await ctx.env.VECTORIZE.upsert([{ id, values, namespace: phone, metadata }]);
      await recordFact(ctx.db, id, phone, fact);
      stored++;
    }
  } catch (err) {
    log.error("store.failed", { phone: maskPhone(phone), err: err instanceof Error ? err : String(err) });
  }
  log.info("store.ok", { phone: maskPhone(phone), candidates: facts.length, stored });
  return stored;
}
