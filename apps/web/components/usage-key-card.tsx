"use client";

import { useState } from "react";
import { fetchKeyDetail } from "@/lib/api";
import { formatNumber, timeAgo } from "@/lib/format";
import type { KeyUsage, ModelUsage } from "@/lib/types";

function pct(used: number, limit: number): number {
  return limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
}

function barColor(p: number): string {
  return p >= 90 ? "bg-red-500" : p >= 70 ? "bg-amber-400" : "bg-emerald-500";
}

export function UsageKeyCard({ k }: { k: KeyUsage }) {
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<ModelUsage[] | null>(null);
  const [loading, setLoading] = useState(false);

  const used = pct(k.totalTokens, k.combinedTokenLimit);
  const status = k.restricted ? "Restricted" : k.isLimited ? "Rate limited" : "Active";
  const dot = k.restricted ? "bg-zinc-500" : k.isLimited ? "bg-red-500" : "bg-emerald-500";

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && !models) {
      setLoading(true);
      try {
        setModels(await fetchKeyDetail(k.index));
      } finally {
        setLoading(false);
      }
    }
  }

  return (
    <div className={`rounded-xl border border-border bg-surface ${k.restricted ? "opacity-60" : ""}`}>
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <div className="flex items-center gap-2">
          <span className="font-medium">API Key #{k.index}</span>
          <span className={`h-2 w-2 rounded-full ${dot}`} />
          <span className="text-sm text-muted">{status}</span>
        </div>
        <span className="font-mono text-xs text-muted">{k.maskedKey}</span>
      </div>

      <div className="space-y-2 px-5 py-4">
        <div className="flex items-center justify-between text-xs uppercase tracking-wide text-muted">
          <span>Token hari ini (semua model)</span>
          <span className="normal-case">{timeAgo(k.lastUsed)}</span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-surface-2">
          <div className={`h-full rounded-full transition-all ${barColor(used)}`} style={{ width: `${used}%` }} />
        </div>
        <div className="flex justify-between text-xs">
          <span className={used >= 90 ? "text-red-400" : "text-muted"}>
            {formatNumber(k.totalTokens)} / {formatNumber(k.combinedTokenLimit)}
          </span>
          <span className="text-muted">{formatNumber(k.totalRequests)} request</span>
        </div>

        <button
          onClick={() => void toggle()}
          disabled={k.restricted}
          className="mt-1 text-xs text-emerald-400 hover:underline disabled:text-muted disabled:no-underline"
        >
          {open ? "▲ Sembunyikan detail" : "▼ Detail per model"}
        </button>

        {open && (
          <div className="mt-2 space-y-2 border-t border-border pt-3">
            {loading && <p className="text-xs text-muted">Memuat…</p>}
            {models?.map((m) => {
              const mp = pct(m.totalTokens, m.tokenLimit);
              return (
                <div key={m.model}>
                  <div className="flex justify-between text-xs">
                    <span className="font-mono text-foreground/80">{m.model}</span>
                    <span className="text-muted">
                      {formatNumber(m.totalTokens)} / {formatNumber(m.tokenLimit)}
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
                    <div className={`h-full rounded-full ${barColor(mp)}`} style={{ width: `${mp}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
