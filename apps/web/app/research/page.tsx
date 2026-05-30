"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getResearch, startResearch } from "@/lib/api";
import { exportDoc, exportPdf } from "@/lib/manuscript-export";
import type { Manuscript, ResearchTask } from "@/lib/types";

const POLL_MS = 4000;

export default function ResearchPage() {
  const [topic, setTopic] = useState("");
  const [task, setTask] = useState<ResearchTask | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const poll = useCallback(async (id: string) => {
    try {
      const t = await getResearch(id);
      setTask(t);
      if (t.status === "done" || t.status === "error") {
        setBusy(false);
        return;
      }
    } catch {
      /* keep polling */
    }
    timer.current = setTimeout(() => void poll(id), POLL_MS);
  }, []);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const t = topic.trim();
    if (!t || busy) return;
    setError(null);
    setBusy(true);
    setTask(null);
    try {
      const { id } = await startResearch(t);
      void poll(id);
    } catch {
      setError("Gagal memulai riset.");
      setBusy(false);
    }
  }

  const m = task?.status === "done" ? task.manuscript : null;

  return (
    <div className="mx-auto max-w-3xl px-5 py-8 sm:px-8">
      <header className="mb-5">
        <h1 className="text-2xl font-semibold tracking-tight">Deep Research</h1>
        <p className="text-sm text-muted">
          Mode jurnal: Linda menyusun manuscript IEEE lengkap. Daftar pustaka hanya paper ber-DOI
          (OpenAlex + Crossref); konteks web dipakai untuk penalaran saja.
        </p>
      </header>

      <form onSubmit={submit} className="mb-6 flex gap-2">
        <input
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          placeholder="Topik / pertanyaan riset…"
          disabled={busy}
          className="flex-1 rounded-lg border border-border bg-surface-2 px-4 py-2 text-sm outline-none focus:border-emerald-500 disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={busy || !topic.trim()}
          className="rounded-lg bg-emerald-600 px-5 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
        >
          {busy ? "Meneliti…" : "Mulai"}
        </button>
      </form>

      {error && <p className="mb-4 text-sm text-red-400">{error}</p>}

      {task && task.status !== "done" && task.status !== "error" && (
        <div className="rounded-xl border border-border bg-surface px-5 py-6 text-center">
          <div className="mb-2 animate-pulse text-emerald-400">● {task.stage}</div>
          <p className="text-xs text-muted">Riset berjalan beberapa menit — biarkan tab ini terbuka.</p>
        </div>
      )}

      {task?.status === "error" && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {task.error || "Riset gagal."}
        </div>
      )}

      {m && <ManuscriptView m={m} />}
    </div>
  );
}

function ManuscriptView({ m }: { m: Manuscript }) {
  return (
    <article className="rounded-xl border border-border bg-surface px-6 py-6">
      <div className="mb-4 flex flex-wrap gap-2">
        <button
          onClick={() => exportDoc(m)}
          className="rounded-lg border border-border bg-surface-2 px-4 py-2 text-sm hover:bg-surface"
        >
          ⬇ Download Word (.doc)
        </button>
        <button
          onClick={() => exportPdf(m)}
          className="rounded-lg border border-border bg-surface-2 px-4 py-2 text-sm hover:bg-surface"
        >
          🖨 PDF (Save as PDF)
        </button>
      </div>

      <h2 className="mb-3 text-center text-xl font-semibold">{m.title}</h2>
      <p className="mb-3 text-sm leading-relaxed">
        <span className="font-semibold italic">Abstract—</span>
        <span className="italic">{m.abstract}</span>
      </p>
      {m.keywords.length > 0 && (
        <p className="mb-4 text-sm">
          <span className="italic">Keywords—</span> {m.keywords.join(", ")}
        </p>
      )}

      {m.sections.map((s, i) => (
        <section key={i} className="mb-4">
          <h3 className="mb-1 font-semibold">{s.heading}</h3>
          {s.body.split(/\n{2,}/).map((p, j) => (
            <p key={j} className="mb-2 text-sm leading-relaxed text-foreground/90">
              {p.trim()}
            </p>
          ))}
        </section>
      ))}

      <h3 className="mb-2 mt-6 font-semibold">References</h3>
      <ol className="space-y-1 text-xs text-foreground/80">
        {m.references.map((r) => (
          <li key={r.n} className="flex gap-2">
            <span className="shrink-0 text-muted">[{r.n}]</span>
            <span>
              {r.ieee}{" "}
              <a
                href={`https://doi.org/${r.doi}`}
                target="_blank"
                rel="noreferrer"
                className="text-emerald-400 hover:underline"
              >
                ↗
              </a>
            </span>
          </li>
        ))}
      </ol>
    </article>
  );
}
