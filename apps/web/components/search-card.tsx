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
    <div className="search-card">
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={searching || info.count === 0}
        className="search-toggle disabled:cursor-default"
      >
        <div className="flex h-9 w-9 items-center justify-center rounded-full border border-border bg-surface-2">
          {searching ? (
            <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          ) : (
            <span className="text-[10px] font-semibold text-accent">WEB</span>
          )}
        </div>
        <div className="flex-1">
          <div className="text-[10px] uppercase tracking-[0.2em] text-muted">Web scan</div>
          <div className="text-sm font-semibold">
            {searching ? "Mencari sumber..." : `Menemukan ${info.count} sumber`}
          </div>
          {info.query && <div className="truncate text-xs text-muted">Query: "{info.query}"</div>}
        </div>
        {!searching && info.count > 0 && <span className="text-xs text-muted">{open ? "Hide" : "Show"}</span>}
      </button>

      {open && info.sources.length > 0 && (
        <ul className="search-list">
          {info.sources.map((s, i) => (
            <li key={i} className="flex gap-2">
              <span className="text-muted">{i + 1}.</span>
              <a
                href={s.url}
                target="_blank"
                rel="noreferrer"
                className="search-link"
                title={s.title}
              >
                <span className="truncate">{s.title || domain(s.url)}</span>
                <span className="text-muted">· {domain(s.url)}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
