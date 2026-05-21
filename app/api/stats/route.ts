import { groqManager } from "@/lib/groq-manager";
import type {
  CombinedStatsResponse,
  KeyStatsResponse,
  StatsResponse,
} from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const states = await groqManager.getStates();
    const now = Date.now();

    const keys: KeyStatsResponse[] = states.map((s) => ({
      index: s.index,
      maskedKey: s.maskedKey,
      isLimited: s.isLimited,
      limitedUntil: s.limitedUntil ? new Date(s.limitedUntil).toISOString() : null,
      remainingTokens: s.remainingTokens,
      limitTokens: s.limitTokens,
      remainingRequests: s.remainingRequests,
      limitRequests: s.limitRequests,
      resetTokensIn: s.resetTokensAt ? Math.max(0, s.resetTokensAt - now) : null,
      resetRequestsIn: s.resetRequestsAt ? Math.max(0, s.resetRequestsAt - now) : null,
      totalTokensUsed: s.totalTokensUsed,
      totalRequestsMade: s.totalRequestsMade,
      lastUsed: s.lastUsed ? new Date(s.lastUsed).toISOString() : null,
    }));

    const limitedKeys = states.filter((s) => s.isLimited).length;
    const combined: CombinedStatsResponse = {
      totalKeys: states.length,
      activeKeys: states.length - limitedKeys,
      limitedKeys,
      totalRemainingTokens: sum(states.map((s) => s.remainingTokens)),
      totalLimitTokens: sum(states.map((s) => s.limitTokens)),
      totalRemainingRequests: sum(states.map((s) => s.remainingRequests)),
      totalRequestsToday: states.reduce((acc, s) => acc + s.totalRequestsMade, 0),
    };

    const body: StatsResponse = { keys, combined, updatedAt: new Date().toISOString() };
    return Response.json(body);
  } catch (err) {
    console.error("[stats] failed:", err);
    return Response.json({ error: "Failed to load stats" }, { status: 500 });
  }
}

function sum(values: (number | null)[]): number {
  return values.reduce<number>((acc, v) => acc + (v ?? 0), 0);
}
