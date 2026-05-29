"use client";

import { useCallback, useEffect, useState } from "react";
import { CombinedStats } from "@/components/combined-stats";
import { TokenCard } from "@/components/token-card";
import type { StatsResponse } from "@/lib/types";

const REFRESH_MS = 30_000;

export default function DashboardPage() {
  const [data, setData] = useState<StatsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [probing, setProbing] = useState(false);

  // probe=true pings each key so the live per-min/per-day limits are refreshed.
  const load = useCallback(async (probe = false) => {
    if (probe) setProbing(true);
    try {
      const res = await fetch(`/api/stats${probe ? "?probe=1" : ""}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`Stats request failed (${res.status})`);
      const json = (await res.json()) as StatsResponse;
      setData(json);
      setError(null);
      setLastUpdated(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load stats");
    } finally {
      if (probe) setProbing(false);
    }
  }, []);

  useEffect(() => {
    // async fetch → setState resolves after await, not synchronously
    /* eslint-disable-next-line react-hooks/set-state-in-effect */
    void load();
    const id = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  return (
    <div className="mx-auto max-w-5xl px-5 py-8 sm:px-8">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Token Usage</h1>
          <p className="text-sm text-muted">Live Groq API key monitoring</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right text-xs text-muted">
            {lastUpdated && <div>Diperbarui {lastUpdated.toLocaleTimeString()}</div>}
            <div>Auto-refresh 30s</div>
          </div>
          <button
            onClick={() => void load(true)}
            disabled={probing}
            className="rounded-lg border border-border bg-surface px-4 py-2 text-sm font-medium transition-colors hover:bg-surface-2 disabled:opacity-50"
          >
            {probing ? "Memuat…" : "↻ Reload"}
          </button>
        </div>
      </header>

      {error && (
        <div className="mb-6 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {!data && !error && <p className="text-muted">Loading…</p>}

      {data && (
        <div className="space-y-6">
          <CombinedStats c={data.combined} />

          {data.keys.length === 0 ? (
            <div className="rounded-xl border border-border bg-surface px-5 py-8 text-center text-muted">
              No Groq API keys detected. Set <code className="font-mono">GROQ_API_KEY_1</code> (and
              more) in your environment.
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {data.keys.map((k) => (
                <TokenCard key={k.index} k={k} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
