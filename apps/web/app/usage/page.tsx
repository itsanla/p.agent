"use client";

import { useCallback, useEffect, useState } from "react";
import { UsageKeyCard } from "@/components/usage-key-card";
import { fetchTavilyUsage, fetchUsage } from "@/lib/api";
import { formatNumber } from "@/lib/format";
import type { TavilyUsage, UsageResponse } from "@/lib/types";

const REFRESH_MS = 30_000;

function Stat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="rounded-xl border border-border bg-surface px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-muted">{label}</div>
      <div className={`mt-1 text-xl font-semibold ${accent ?? ""}`}>{value}</div>
    </div>
  );
}

export default function UsagePage() {
  const [data, setData] = useState<UsageResponse | null>(null);
  const [tavily, setTavily] = useState<TavilyUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updated, setUpdated] = useState<Date | null>(null);

  const load = useCallback(async () => {
    try {
      const [u, t] = await Promise.all([fetchUsage(), fetchTavilyUsage().catch(() => null)]);
      setData(u);
      setTavily(t);
      setError(null);
      setUpdated(new Date());
    } catch {
      setError("Gagal memuat usage.");
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  const c = data?.combined;

  return (
    <div className="mx-auto max-w-5xl px-5 py-8 sm:px-8">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Token Usage</h1>
          <p className="text-sm text-muted">Kuota Groq per API key — klik Detail untuk rincian per model.</p>
        </div>
        <div className="text-right text-xs text-muted">
          {updated && <div>Diperbarui {updated.toLocaleTimeString()}</div>}
          <div>Auto-refresh 30s</div>
        </div>
      </header>

      {error && (
        <div className="mb-6 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {!data && !error && <p className="text-muted">Loading…</p>}

      {data && c && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Key aktif" value={`${c.activeKeys}/${c.totalKeys}`} />
            <Stat label="Restricted" value={String(c.restrictedKeys)} accent={c.restrictedKeys ? "text-amber-400" : ""} />
            <Stat label="Token hari ini" value={formatNumber(c.totalTokensToday)} />
            <Stat label="Limit harian total" value={formatNumber(c.combinedDailyTokenLimit)} />
          </div>

          <h2 className="pt-2 text-sm font-semibold uppercase tracking-wide text-muted">Groq — token harian per key</h2>
          <div className="grid gap-4 md:grid-cols-2">
            {data.keys.map((k) => (
              <UsageKeyCard key={k.index} k={k} />
            ))}
          </div>

          {tavily && tavily.keys.length > 0 && (
            <>
              <h2 className="pt-4 text-sm font-semibold uppercase tracking-wide text-muted">
                Tavily — kredit pencarian (bulan {tavily.month})
              </h2>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label="Key" value={String(tavily.combined.totalKeys)} />
                <Stat label="Kredit terpakai" value={formatNumber(tavily.combined.creditsUsed)} />
                <Stat label="Limit bulanan" value={formatNumber(tavily.combined.creditLimit)} />
                <Stat
                  label="Sisa"
                  value={formatNumber(tavily.combined.creditLimit - tavily.combined.creditsUsed)}
                />
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                {tavily.keys.map((k) => {
                  const pctUsed = k.limit > 0 ? Math.min(100, (k.creditsUsed / k.limit) * 100) : 0;
                  return (
                    <div key={k.index} className="rounded-xl border border-border bg-surface px-5 py-3">
                      <div className="mb-2 flex items-center justify-between text-sm">
                        <span className="font-medium">Tavily Key #{k.index}</span>
                        <span className={k.exhausted ? "text-amber-400" : "text-muted"}>
                          {k.exhausted ? "Habis" : "Aktif"}
                        </span>
                      </div>
                      <div className="h-2 w-full overflow-hidden rounded-full bg-surface-2">
                        <div
                          className={`h-full rounded-full ${pctUsed >= 90 ? "bg-red-500" : pctUsed >= 70 ? "bg-amber-400" : "bg-emerald-500"}`}
                          style={{ width: `${pctUsed}%` }}
                        />
                      </div>
                      <div className="mt-1 text-xs text-muted">
                        {formatNumber(k.creditsUsed)} / {formatNumber(k.limit)} kredit
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
