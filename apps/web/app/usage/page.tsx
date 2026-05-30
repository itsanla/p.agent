"use client";

import { useCallback, useEffect, useState } from "react";
import { UsageKeyCard } from "@/components/usage-key-card";
import { fetchTavilyUsage, fetchUsage } from "@/lib/api";
import { formatNumber } from "@/lib/format";
import type { TavilyUsage, UsageResponse } from "@/lib/types";

const REFRESH_MS = 30_000;

function Stat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="stat-card">
      <div className="text-xs uppercase tracking-[0.2em] text-muted">{label}</div>
      <div className={`stat-value ${accent ?? ""}`}>{value}</div>
    </div>
  );
}

function tone(p: number): string {
  return p >= 90 ? "progress-fill danger" : p >= 70 ? "progress-fill warn" : "progress-fill ok";
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
    <div className="page-shell">
      <header className="page-hero reveal">
        <div className="eyebrow">Usage Monitor</div>
        <div className="hero-grid">
          <div>
            <h1 className="title-display">Token Usage</h1>
            <p className="mt-3 text-sm text-muted">
              Kuota Groq per API key. Klik Detail untuk melihat rincian per model secara real-time.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <span className="chip accent">Auto refresh 30s</span>
              <span className="chip">Usage gabungan</span>
              <span className="chip">Monitoring Tavily</span>
            </div>
          </div>
          <div className="hero-card">
            <div className="text-xs uppercase tracking-[0.2em] text-muted">Status</div>
            <div className="mt-2 text-lg font-semibold">Live usage feed</div>
            <p className="mt-2 text-xs text-muted">
              {updated ? `Diperbarui ${updated.toLocaleTimeString()}` : "Menunggu data terbaru"}
            </p>
          </div>
        </div>
      </header>

      {error && <p className="alert">{error}</p>}

      {!data && !error && <p className="text-muted">Loading...</p>}

      {data && c && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Key aktif" value={`${c.activeKeys}/${c.totalKeys}`} />
            <Stat label="Restricted" value={String(c.restrictedKeys)} accent={c.restrictedKeys ? "text-accent-2" : ""} />
            <Stat label="Token hari ini" value={formatNumber(c.totalTokensToday)} />
            <Stat label="Limit harian" value={formatNumber(c.combinedDailyTokenLimit)} />
          </div>

          <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">Groq token per key</h2>
          <div className="grid gap-4 md:grid-cols-2">
            {data.keys.map((k) => (
              <UsageKeyCard key={k.index} k={k} />
            ))}
          </div>

          {tavily && tavily.keys.length > 0 && (
            <>
              <h2 className="pt-4 text-xs font-semibold uppercase tracking-[0.2em] text-muted">
                Tavily kredit pencarian (bulan {tavily.month})
              </h2>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label="Key" value={String(tavily.combined.totalKeys)} />
                <Stat label="Kredit terpakai" value={formatNumber(tavily.combined.creditsUsed)} />
                <Stat label="Limit bulanan" value={formatNumber(tavily.combined.creditLimit)} />
                <Stat label="Sisa" value={formatNumber(tavily.combined.creditLimit - tavily.combined.creditsUsed)} />
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                {tavily.keys.map((k) => {
                  const pctUsed = k.limit > 0 ? Math.min(100, (k.creditsUsed / k.limit) * 100) : 0;
                  return (
                    <div key={k.index} className="surface-card p-5">
                      <div className="mb-2 flex items-center justify-between text-sm">
                        <span className="font-semibold">Tavily Key #{k.index}</span>
                        <span className={k.exhausted ? "text-accent-2" : "text-muted"}>
                          {k.exhausted ? "Habis" : "Aktif"}
                        </span>
                      </div>
                      <div className="progress-track">
                        <div className={`${tone(pctUsed)}`} style={{ width: `${pctUsed}%` }} />
                      </div>
                      <div className="mt-2 text-xs text-muted">
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
