import { Cache } from "./cache";
import { getDb, type DB } from "./db";
import { GroqManager } from "./groq";
import { TavilyManager } from "./tavily";

// Per-request context: wires up D1, Redis cache, the Groq manager, and the Tavily
// manager from the Worker env (which also carries the AI + VECTORIZE bindings).
// Built once per request and threaded through the agent + research pipeline.
export interface Ctx {
  env: Env;
  db: DB;
  cache: Cache;
  groq: GroqManager;
  tavily: TavilyManager;
}

export function buildCtx(env: Env): Ctx {
  const db = getDb(env.DB);
  const cache = new Cache(env);
  const envRec = env as unknown as Record<string, unknown>;
  const groq = new GroqManager(envRec, db, cache);
  const tavily = new TavilyManager(envRec, db, cache);
  return { env, db, cache, groq, tavily };
}
