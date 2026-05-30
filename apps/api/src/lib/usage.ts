import type { Ctx } from "./context";
import { getUsageForDay, getUsageForKey } from "./db";
import { COMBINED_TPD_PER_KEY, MODELS, modelInfo } from "./models";
import type { KeyUsage, ModelUsage, UsageResponse } from "./types";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Default /usage view: one aggregated row per key (tokens summed across models). */
export async function buildUsage(ctx: Ctx): Promise<UsageResponse> {
  const [states, rows] = await Promise.all([ctx.groq.getStates(), getUsageForDay(ctx.db, today())]);

  // Sum today's counters per key index.
  const byKey = new Map<number, { tokens: number; requests: number; lastUpdated: number }>();
  for (const r of rows) {
    const agg = byKey.get(r.keyIndex) ?? { tokens: 0, requests: 0, lastUpdated: 0 };
    agg.tokens += r.totalTokens;
    agg.requests += r.totalRequests;
    agg.lastUpdated = Math.max(agg.lastUpdated, r.lastUpdated);
    byKey.set(r.keyIndex, agg);
  }

  const keys: KeyUsage[] = states.map((s) => {
    const agg = byKey.get(s.index);
    const lastUsedMs = s.lastUsed ?? agg?.lastUpdated ?? null;
    return {
      index: s.index,
      maskedKey: s.maskedKey,
      restricted: s.restricted,
      isLimited: s.isLimited,
      limitedUntil: s.limitedUntil ? new Date(s.limitedUntil).toISOString() : null,
      totalTokens: agg?.tokens ?? 0,
      totalRequests: agg?.requests ?? 0,
      combinedTokenLimit: COMBINED_TPD_PER_KEY,
      lastUsed: lastUsedMs ? new Date(lastUsedMs).toISOString() : null,
    };
  });

  const restrictedKeys = keys.filter((k) => k.restricted).length;
  const limitedKeys = keys.filter((k) => k.isLimited && !k.restricted).length;
  return {
    keys,
    combined: {
      totalKeys: keys.length,
      activeKeys: keys.length - restrictedKeys,
      restrictedKeys,
      limitedKeys,
      totalTokensToday: keys.reduce((a, k) => a + k.totalTokens, 0),
      totalRequestsToday: keys.reduce((a, k) => a + k.totalRequests, 0),
      combinedDailyTokenLimit: keys.reduce((a, k) => a + (k.restricted ? 0 : k.combinedTokenLimit), 0),
    },
    updatedAt: new Date().toISOString(),
  };
}

/** Per-model breakdown for one key (the "Detail" drilldown). */
export async function buildKeyDetail(ctx: Ctx, keyIndex: number): Promise<ModelUsage[]> {
  const rows = await getUsageForKey(ctx.db, today(), keyIndex);
  const used = new Map(rows.map((r) => [r.model, r]));

  // List every known model so unused ones still show (0 used / full limit).
  return MODELS.map((m) => {
    const r = used.get(m.id);
    const info = modelInfo(m.id);
    return {
      model: m.id,
      totalTokens: r?.totalTokens ?? 0,
      totalRequests: r?.totalRequests ?? 0,
      tokenLimit: info?.tokensPerDay ?? 0,
      requestLimit: info?.requestsPerDay ?? 0,
    };
  });
}
