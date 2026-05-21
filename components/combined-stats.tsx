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
  return (
    <div className="rounded-xl border border-border bg-gradient-to-br from-surface to-surface-2 p-6">
      <div className="mb-4 flex items-center gap-2 text-sm font-medium uppercase tracking-wider text-muted">
        All Keys Combined
      </div>
      <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
        <Stat label="Total Tokens / min" value={formatNumber(c.totalLimitTokens)} />
        <Stat label="Total Remaining" value={formatNumber(c.totalRemainingTokens)} />
        <Stat label="Active Keys" value={`${c.activeKeys}/${c.totalKeys}`} />
        <Stat label="Requests Today" value={formatNumber(c.totalRequestsToday)} />
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
