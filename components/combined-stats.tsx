import { formatNumber } from "@/lib/format";
import type { CombinedStatsResponse } from "@/lib/types";

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

export function CombinedStats({ c }: { c: CombinedStatsResponse }) {
  const dailyLimit = c.totalDailyTokenLimit; // combined daily token budget
  const usedPct = dailyLimit > 0 ? Math.min(100, (c.totalTokensToday / dailyLimit) * 100) : 0;
  const level = usedPct >= 90 ? "bg-red-500" : usedPct >= 70 ? "bg-amber-400" : "bg-emerald-500";

  return (
    <div className="rounded-xl border border-border bg-gradient-to-br from-surface to-surface-2 p-6">
      <div className="mb-4 flex items-center gap-2 text-sm font-medium uppercase tracking-wider text-muted">
        All Keys Combined
      </div>
      <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
        <Stat label="Active Keys" value={`${c.activeKeys}/${c.totalKeys}`} />
        <Stat label="Requests Today" value={formatNumber(c.totalRequestsToday)} />
        <Stat label="Tokens Today" value={formatNumber(c.totalTokensToday)} />
        <Stat label="Sisa Token Harian" value={formatNumber(Math.max(0, dailyLimit - c.totalTokensToday))} />
      </div>

      {/* Daily token budget (TPD) — the limit that usually runs out first. */}
      <div className="mt-5">
        <div className="mb-1 flex justify-between text-xs text-muted">
          <span>Penggunaan token harian</span>
          <span>
            {formatNumber(c.totalTokensToday)} / {formatNumber(dailyLimit)} ({Math.round(usedPct)}%)
          </span>
        </div>
        <div className="h-2.5 w-full overflow-hidden rounded-full bg-surface-2">
          <div className={`h-full rounded-full transition-all ${level}`} style={{ width: `${usedPct}%` }} />
        </div>
      </div>

      {c.limitedKeys > 0 && (
        <div className="mt-4 inline-flex items-center gap-2 rounded-md bg-red-500/10 px-3 py-1 text-sm text-red-400">
          <span className="h-2 w-2 rounded-full bg-red-500" />
          {c.limitedKeys} key{c.limitedKeys > 1 ? "s" : ""} rate limited
        </div>
      )}
    </div>
  );
}
