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
    <div className="page-shell">
      <header className="page-hero reveal">
        <div className="eyebrow">Deep Research</div>
        <div className="hero-grid">
          <div>
            <h1 className="title-display">Manuscript Lab</h1>
            <p className="mt-3 text-sm text-muted">
              Mode jurnal: Linda menyusun manuscript IEEE lengkap. Daftar pustaka hanya paper
              ber-DOI (OpenAlex + Crossref). Konteks web dipakai untuk penalaran saja.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <span className="chip accent">IEEE-ready</span>
              <span className="chip">Auto citation</span>
              <span className="chip">Ekspor DOC/PDF</span>
            </div>
          </div>
          <div className="hero-card">
            <div className="text-xs uppercase tracking-[0.2em] text-muted">Output</div>
            <div className="mt-2 text-lg font-semibold">Manuscript lengkap</div>
            <p className="mt-2 text-xs text-muted">
              Linda menyusun abstrak, metodologi, diskusi, dan referensi terformat otomatis.
            </p>
          </div>
        </div>
      </header>

      <form onSubmit={submit} className="surface-card p-5 reveal delay-1">
        <div className="flex flex-col gap-3 md:flex-row md:items-center">
          <input
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="Topik atau pertanyaan riset..."
            disabled={busy}
            className="input-field flex-1"
          />
          <button type="submit" disabled={busy || !topic.trim()} className="btn-primary">
            {busy ? "Meneliti..." : "Mulai"}
          </button>
        </div>
        <p className="mt-3 text-xs text-muted">
          Proses riset berjalan beberapa menit. Biarkan tab ini tetap terbuka.
        </p>
      </form>

      {error && <p className="alert">{error}</p>}

      {task && task.status !== "done" && task.status !== "error" && (
        <div className="surface-card soft p-6 text-center">
          <div className="chip accent">Stage: {task.stage}</div>
          <p className="mt-3 text-xs text-muted">Riset berjalan beberapa menit. Mohon tunggu.</p>
        </div>
      )}

      {task?.status === "error" && <p className="alert">{task.error || "Riset gagal."}</p>}

      {m && <ManuscriptView m={m} />}
    </div>
  );
}

function ManuscriptView({ m }: { m: Manuscript }) {
  return (
    <article className="manuscript-card reveal delay-2">
      <div className="mb-4 flex flex-wrap gap-2">
        <button onClick={() => exportDoc(m)} className="btn-secondary">
          Download Word (.doc)
        </button>
        <button onClick={() => exportPdf(m)} className="btn-secondary">
          PDF (Save as PDF)
        </button>
      </div>

      <h2 className="mb-3 text-xl font-semibold">{m.title}</h2>
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
          <h3 className="mb-2 font-semibold">{s.heading}</h3>
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
                className="text-accent-3 hover:underline"
              >
                link
              </a>
            </span>
          </li>
        ))}
      </ol>
    </article>
  );
}
