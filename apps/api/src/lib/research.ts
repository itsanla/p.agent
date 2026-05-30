import type { Ctx } from "./context";
import { updateResearchTask } from "./db";
import { logger } from "./logger";
import { crossrefVerify, openAlexSearch, type ScholarCandidate, type VerifiedRef } from "./scholar";

// Deep-research pipeline (web-only "deep search" mode) that produces a full IEEE
// journal manuscript. STRICT DOI-only bibliography: every reference is discovered
// on OpenAlex and verified on Crossref; any source without a resolvable DOI is
// excluded from the reference list. Web context (Tavily) only informs reasoning —
// it is never cited. Custom pipeline (no Tavily Research endpoint).

const log = logger("research");

const MAX_CANDIDATES = 24; // OpenAlex candidates gathered before verification
const MAX_REFS = 12; // verified DOI references kept
const MAX_EXTRACT = 4; // open-access full-texts pulled via Tavily

export interface Reference {
  n: number;
  ieee: string;
  doi: string;
}
export interface Manuscript {
  title: string;
  abstract: string;
  keywords: string[];
  sections: { heading: string; body: string }[];
  references: Reference[];
}

/** Run the full pipeline for `topic`, updating task status in D1 at each stage. */
export async function runResearch(ctx: Ctx, taskId: string, topic: string): Promise<void> {
  const env = ctx.env as unknown as Record<string, string | undefined>;
  const planModel = env.GROQ_PLAN_MODEL || "openai/gpt-oss-120b";
  const synthModel = env.GROQ_SYNTH_MODEL || "meta-llama/llama-4-scout-17b-16e-instruct";
  const writeModel = env.GROQ_WRITE_MODEL || "openai/gpt-oss-120b";
  const mailto = env.SCHOLAR_MAILTO || "linda@example.com";

  const setStage = (stage: string, status: "running" | "done" | "error" = "running") =>
    updateResearchTask(ctx.db, taskId, { status, stage });

  try {
    await setStage("Merencanakan riset…");
    const plan = await planResearch(ctx, planModel, topic);

    // ── Discover DOI-bearing papers on OpenAlex ──
    await setStage("Mencari paper ilmiah (OpenAlex)…");
    const candidates = new Map<string, ScholarCandidate>();
    for (const q of plan.queries) {
      for (const c of await openAlexSearch(q, 6, mailto)) {
        if (!candidates.has(c.doi)) candidates.set(c.doi, c);
      }
      if (candidates.size >= MAX_CANDIDATES) break;
    }
    const ranked = [...candidates.values()].sort((a, b) => b.citedBy - a.citedBy).slice(0, MAX_REFS + 4);

    // ── Verify each DOI on Crossref (authoritative IEEE metadata) ──
    await setStage("Memverifikasi DOI (Crossref)…");
    const verified = (
      await mapLimit(ranked, 5, (c) => crossrefVerify(c.doi, mailto))
    ).filter((r): r is VerifiedRef => r !== null).slice(0, MAX_REFS);

    if (verified.length === 0) {
      await updateResearchTask(ctx.db, taskId, {
        status: "error",
        stage: "Gagal",
        error: "Tidak menemukan paper ber-DOI yang relevan untuk topik ini.",
      });
      return;
    }

    // Stable numbering for the writer to cite against.
    const numbered = verified.map((r, i) => ({ ...r, n: i + 1 }));
    const byDoi = new Map(candidates.entries());

    // ── Web context (reasoning only, NOT cited) ──
    await setStage("Mengumpulkan konteks web…");
    let webContext = "";
    if (ctx.tavily.configured) {
      for (const q of plan.contextQueries.slice(0, 2)) {
        try {
          const r = await ctx.tavily.search(q, { searchDepth: "advanced", includeAnswer: "advanced", maxResults: 4 });
          if (r.answer) webContext += `- ${r.answer}\n`;
        } catch (err) {
          log.warn("context.search.failed", { err: err instanceof Error ? err.message : String(err) });
        }
      }
    }

    // ── Read sources (abstracts + a few open-access full texts) ──
    await setStage("Membaca sumber…");
    const oaUrls = numbered
      .map((r) => byDoi.get(r.doi)?.oaUrl)
      .filter((u): u is string => Boolean(u))
      .slice(0, MAX_EXTRACT);
    const extracted = ctx.tavily.configured && oaUrls.length ? await ctx.tavily.extract(oaUrls).catch(() => []) : [];
    const extraByUrl = new Map(extracted.map((e) => [e.url, e.rawContent]));

    const sourcesDigest = numbered
      .map((r) => {
        const cand = byDoi.get(r.doi);
        const oa = cand?.oaUrl ? extraByUrl.get(cand.oaUrl) : "";
        const body = (oa || cand?.abstract || "").slice(0, 1200);
        return `[${r.n}] ${r.title} (${r.year ?? "n.d."}). ${body}`;
      })
      .join("\n\n");

    // ── Synthesize grounded notes (long-context model) ──
    await setStage("Menyintesis sumber…");
    const notes = await synthesize(ctx, synthModel, topic, plan.outline, sourcesDigest, webContext);

    // ── Write the IEEE manuscript (strict: cite only [n] from the list) ──
    await setStage("Menulis manuscript IEEE…");
    const draft = await writeManuscript(ctx, writeModel, topic, plan.outline, notes, numbered);

    // ── Finalize citations: keep only cited refs, renumber sequentially ──
    await setStage("Memeriksa sitasi…");
    const manuscript = finalizeCitations(draft, numbered);

    await updateResearchTask(ctx.db, taskId, {
      status: "done",
      stage: "Selesai",
      manuscript: JSON.stringify(manuscript),
    });
    log.info("done", { taskId, refs: manuscript.references.length, sections: manuscript.sections.length });
  } catch (err) {
    log.error("failed", { taskId, err: err instanceof Error ? err : String(err) });
    await updateResearchTask(ctx.db, taskId, {
      status: "error",
      stage: "Gagal",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Steps ─────────────────────────────────────────────────────────────────────

interface Plan {
  queries: string[];
  contextQueries: string[];
  outline: string[];
}

async function planResearch(ctx: Ctx, model: string, topic: string): Promise<Plan> {
  const system = `Kamu perencana riset akademik. Untuk topik yang diberikan, hasilkan rencana riset dalam JSON.
Balas HANYA JSON valid dengan bentuk:
{"queries":["kueri pencarian ilmiah berbahasa Inggris untuk OpenAlex", ...5-7 item],
 "contextQueries":["kueri konteks web umum", ...2 item],
 "outline":["I. Introduction","II. ...", ...4-6 judul bagian gaya jurnal IEEE]}
queries harus spesifik dan dalam bahasa Inggris (mesin pencari ilmiah). outline mengikuti struktur paper IEEE.`;
  const raw = await ctx.groq.generate([{ role: "user", content: `Topik: ${topic}` }], {
    systemPrompt: system,
    model,
    temperature: 0.3,
    maxOutputTokens: 1200,
  });
  const p = parseJson<Plan>(raw.text);
  return {
    queries: Array.isArray(p?.queries) && p.queries.length ? p.queries.slice(0, 7) : [topic],
    contextQueries: Array.isArray(p?.contextQueries) ? p.contextQueries.slice(0, 2) : [],
    outline:
      Array.isArray(p?.outline) && p.outline.length
        ? p.outline
        : ["I. Introduction", "II. Related Work", "III. Discussion", "IV. Conclusion"],
  };
}

async function synthesize(
  ctx: Ctx,
  model: string,
  topic: string,
  outline: string[],
  sourcesDigest: string,
  webContext: string,
): Promise<string> {
  const system = `Kamu analis riset. Berdasarkan SUMBER ILMIAH ber-nomor dan KONTEKS WEB, susun catatan tersintesis per bagian outline.
Aturan: setiap klaim dari sumber ilmiah TANDAI dengan nomor sumbernya, mis. [1], [3]. Konteks web boleh dipakai untuk latar belakang tetapi JANGAN diberi nomor sitasi. Jangan mengarang temuan.`;
  const prompt = `Topik: ${topic}

Outline: ${outline.join("; ")}

SUMBER ILMIAH (ber-nomor, untuk disitasi):
${sourcesDigest}

KONTEKS WEB (latar belakang, tidak disitasi):
${webContext || "(tidak ada)"}

Tulis catatan tersintesis per bagian (poin-poin), dengan sitasi [n] pada klaim dari sumber ilmiah.`;
  const r = await ctx.groq.generate([{ role: "user", content: prompt }], {
    systemPrompt: system,
    model,
    temperature: 0.3,
    maxOutputTokens: 4000,
  });
  return r.text;
}

interface DraftManuscript {
  title: string;
  abstract: string;
  keywords: string[];
  sections: { heading: string; body: string }[];
}

async function writeManuscript(
  ctx: Ctx,
  model: string,
  topic: string,
  outline: string[],
  notes: string,
  refs: { n: number; title: string; year: number | null }[],
): Promise<DraftManuscript> {
  const refList = refs.map((r) => `[${r.n}] ${r.title} (${r.year ?? "n.d."})`).join("\n");
  // Keep the prompt lean so input + output stays under the write model's TPM.
  const notesTrimmed = notes.slice(0, 8000);
  const system = `Kamu penulis manuscript jurnal ilmiah gaya IEEE. Tulis manuscript LENGKAP berdasarkan catatan riset.
ATURAN SITASI KETAT:
- Sitasi inline HANYA boleh memakai nomor dari DAFTAR REFERENSI yang diberikan, format [n] atau [n], [m].
- JANGAN membuat nomor sitasi di luar daftar. JANGAN mengarang referensi.
- Konteks latar belakang yang bukan dari referensi boleh ditulis tanpa sitasi.
Balas HANYA JSON valid:
{"title":"...","abstract":"...","keywords":["..."],"sections":[{"heading":"I. Introduction","body":"... dengan sitasi [1] ..."}, ...]}
Tulis dalam bahasa yang sesuai topik (default Inggris bila topik teknis internasional). Setiap section padat dan ilmiah.`;
  const prompt = `Topik: ${topic}

Outline: ${outline.join("; ")}

DAFTAR REFERENSI (hanya ini yang boleh disitasi):
${refList}

CATATAN RISET TERSINTESIS:
${notesTrimmed}

Tulis manuscript lengkap (JSON).`;
  const r = await ctx.groq.generate([{ role: "user", content: prompt }], {
    systemPrompt: system,
    model,
    temperature: 0.4,
    maxOutputTokens: 6000,
  });
  const d = parseJson<DraftManuscript>(r.text);
  return {
    title: d?.title || topic,
    abstract: d?.abstract || "",
    keywords: Array.isArray(d?.keywords) ? d.keywords : [],
    sections: Array.isArray(d?.sections) ? d.sections.filter((s) => s && s.heading && s.body) : [],
  };
}

// ── Citation finalization: keep only cited DOI refs, renumber 1..k ─────────────

function finalizeCitations(draft: DraftManuscript, numbered: VerifiedRef[]): Manuscript {
  const refByN = new Map(numbered.map((r, i) => [i + 1, r]));
  const order: number[] = []; // old numbers in first-appearance order
  const seen = new Set<number>();

  const scan = (text: string) => {
    const re = /\[(\d+)\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const n = Number(m[1]);
      if (refByN.has(n) && !seen.has(n)) {
        seen.add(n);
        order.push(n);
      }
    }
  };
  scan(draft.abstract);
  for (const s of draft.sections) scan(s.body);

  const remap = new Map<number, number>();
  order.forEach((oldN, i) => remap.set(oldN, i + 1));

  // Rewrite [old] → [new]; drop citations to numbers not in our verified set.
  const rewrite = (text: string) =>
    text.replace(/\[(\d+)\]/g, (full, d) => {
      const n = Number(d);
      return remap.has(n) ? `[${remap.get(n)}]` : refByN.has(n) ? full : "";
    });

  const references: Reference[] = order.map((oldN, i) => {
    const r = refByN.get(oldN)!;
    return { n: i + 1, ieee: r.ieee, doi: r.doi };
  });

  return {
    title: draft.title,
    abstract: rewrite(draft.abstract),
    keywords: draft.keywords,
    sections: draft.sections.map((s) => ({ heading: s.heading, body: rewrite(s.body) })),
    references,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function parseJson<T>(raw: string): T | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    out.push(...(await Promise.all(items.slice(i, i + limit).map(fn))));
  }
  return out;
}
