import { NextRequest } from "next/server";
import { groqManager } from "@/lib/groq-manager";
import type {
  CombinedStatsResponse,
  KeyStatsResponse,
  StatsResponse,
} from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TPD_LIMIT = Number(process.env.GROQ_TPD_LIMIT ?? 100000);

export async function GET(req: NextRequest): Promise<Response> {
  try {
    // ?probe=1 actively pings each key to refresh live rate-limit headers.
    if (req.nextUrl.searchParams.get("probe") === "1") {
      await groqManager.probeAll();
    }
    const states = await groqManager.getStates();
    const now = Date.now();

    const keys: KeyStatsResponse[] = states.map((s) => {
      // Prefer Groq's reported daily figure (from a 429); else our estimate.
      const dailyFromGroq = s.reportedTokensUsed != null;
      const dailyTokensUsed = s.reportedTokensUsed ?? s.totalTokensUsed;
      const dailyTokenLimit = s.reportedTokenLimit ?? TPD_LIMIT;
      return {
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
        dailyTokensUsed,
        dailyTokenLimit,
        dailyFromGroq,
      };
    });

    const limitedKeys = states.filter((s) => s.isLimited).length;
    const combined: CombinedStatsResponse = {
      totalKeys: states.length,
      activeKeys: states.length - limitedKeys,
      limitedKeys,
      totalRemainingTokens: sum(states.map((s) => s.remainingTokens)),
      totalLimitTokens: sum(states.map((s) => s.limitTokens)),
      totalRemainingRequests: sum(states.map((s) => s.remainingRequests)),
      totalRequestsToday: states.reduce((acc, s) => acc + s.totalRequestsMade, 0),
      totalTokensToday: keys.reduce((acc, k) => acc + k.dailyTokensUsed, 0),
      totalDailyTokenLimit: keys.reduce((acc, k) => acc + k.dailyTokenLimit, 0),
    };

    const body: StatsResponse = {
      keys,
      combined,
      tpdLimit: TPD_LIMIT,
      updatedAt: new Date().toISOString(),
    };
    return Response.json(body);
  } catch (err) {
    console.error("[stats] failed:", err);
    return Response.json({ error: "Failed to load stats" }, { status: 500 });
  }
}

function sum(values: (number | null)[]): number {
  return values.reduce<number>((acc, v) => acc + (v ?? 0), 0);
}
