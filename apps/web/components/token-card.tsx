import {
  formatDuration,
  formatNumber,
  remainingPct,
  statusLevel,
  timeAgo,
  type StatusLevel,
} from "@/lib/format";
import type { KeyStatsResponse } from "@/lib/types";

const DOT: Record<StatusLevel, string> = {
  green: "bg-emerald-500",
  yellow: "bg-amber-400",
  red: "bg-red-500",
};

const BAR: Record<StatusLevel, string> = {
  green: "bg-emerald-500",
  yellow: "bg-amber-400",
  red: "bg-red-500",
};

function ProgressBar({
  remaining,
  limit,
  level,
}: {
  remaining: number | null;
  limit: number | null;
  level: StatusLevel;
}) {
  const pct = remainingPct(remaining, limit) ?? (remaining == null ? 0 : 100);
  return (
    <div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-surface-2">
        <div
          className={`h-full rounded-full transition-all ${BAR[level]}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="mt-1 text-right text-xs text-muted">
        {formatNumber(remaining)} / {formatNumber(limit)}
      </div>
    </div>
  );
}

export function TokenCard({ k }: { k: KeyStatsResponse }) {
  const tokenPct = remainingPct(k.remainingTokens, k.limitTokens);
  const reqPct = remainingPct(k.remainingRequests, k.limitRequests);
  const level = statusLevel(tokenPct, k.isLimited);
  const statusText = k.isLimited ? "Rate limited" : "Active";

  // Daily token budget (TPD) — usually the real constraint. Color by usage.
  const dailyUsedPct =
    k.dailyTokenLimit > 0 ? Math.min(100, (k.dailyTokensUsed / k.dailyTokenLimit) * 100) : 0;
  const dailyLevel: StatusLevel = dailyUsedPct >= 90 ? "red" : dailyUsedPct >= 70 ? "yellow" : "green";

  return (
    <div className="rounded-xl border border-border bg-surface">
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <div className="flex items-center gap-2">
          <span className="font-medium">API Key #{k.index}</span>
          <span className={`h-2 w-2 rounded-full ${DOT[level]}`} />
          <span className="text-sm text-muted">{statusText}</span>
        </div>
        <span className="font-mono text-xs text-muted">{k.maskedKey}</span>
      </div>

      <div className="space-y-4 px-5 py-4">
        <div>
          <div className="mb-1 text-xs uppercase tracking-wide text-muted">
            Remaining Tokens (per min)
          </div>
          <ProgressBar remaining={k.remainingTokens} limit={k.limitTokens} level={level} />
        </div>

        <div>
          <div className="mb-1 text-xs uppercase tracking-wide text-muted">
            Remaining Requests (per day)
          </div>
          <ProgressBar
            remaining={k.remainingRequests}
            limit={k.limitRequests}
            level={statusLevel(reqPct, k.isLimited)}
          />
        </div>

        <div className="flex justify-between text-xs text-muted">
          <span>Tokens reset in: {formatDuration(k.resetTokensIn)}</span>
          <span>Requests reset in: {formatDuration(k.resetRequestsIn)}</span>
        </div>
      </div>

      <div className="border-t border-border px-5 py-3">
        <div className="mb-1 flex items-center justify-between text-xs uppercase tracking-wide text-muted">
          <span>
            Tokens hari ini (TPD){" "}
            <span className="normal-case">{k.dailyFromGroq ? "· dari Groq" : "· perkiraan"}</span>
          </span>
          <span className="ml-auto normal-case text-muted">{timeAgo(k.lastUsed)}</span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-surface-2">
          <div
            className={`h-full rounded-full transition-all ${BAR[dailyLevel]}`}
            style={{ width: `${dailyUsedPct}%` }}
          />
        </div>
        <div className="mt-1 flex justify-between text-xs">
          <span className={dailyLevel === "red" ? "text-red-400" : "text-muted"}>
            {formatNumber(k.dailyTokensUsed)} / {formatNumber(k.dailyTokenLimit)}
          </span>
          <span className="text-muted">Requests: {formatNumber(k.totalRequestsMade)}</span>
        </div>
      </div>
    </div>
  );
}
