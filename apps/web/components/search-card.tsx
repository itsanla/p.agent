"use client";

import { useState } from "react";
import type { SearchInfo } from "@/lib/types";

function domain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Claude/Grok-style web-search indicator attached to an assistant message. */
export function SearchCard({ info }: { info: SearchInfo }) {
  const [open, setOpen] = useState(false);
  const searching = info.status === "searching";

  return (
    <div className="mb-2 rounded-lg border border-border bg-surface-2/60 text-xs">
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={searching || info.count === 0}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-muted disabled:cursor-default"
      >
        {searching ? (
          <>
            <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
            <span>Mencari web…</span>
          </>
        ) : (
          <>
            <span>🌐</span>
            <span className="text-foreground/80">Menelusuri {info.count} situs</span>
          </>
        )}
        {info.query && <span className="truncate italic opacity-70">“{info.query}”</span>}
        {!searching && info.count > 0 && <span className="ml-auto">{open ? "▲" : "▼"}</span>}
      </button>

      {open && info.sources.length > 0 && (
        <ul className="space-y-1 border-t border-border px-3 py-2">
          {info.sources.map((s, i) => (
            <li key={i} className="flex gap-2">
              <span className="text-muted">{i + 1}.</span>
              <a
                href={s.url}
                target="_blank"
                rel="noreferrer"
                className="truncate text-emerald-400 hover:underline"
                title={s.title}
              >
                {s.title || domain(s.url)}
                <span className="ml-1 text-muted">· {domain(s.url)}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
