import { logger } from "./logger";

// Scholarly layer for the DOI-only bibliography. Discovery via OpenAlex (free,
// returns DOI papers + metadata), authoritative verification + IEEE fields via
// Crossref. Only papers whose DOI resolves on Crossref may enter the reference
// list — non-DOI / unresolvable sources are dropped.

const log = logger("scholar");

const OPENALEX = "https://api.openalex.org/works";
const CROSSREF = "https://api.crossref.org/works";

export interface ScholarCandidate {
  doi: string; // bare DOI, e.g. 10.1109/tifs.2020.2988575
  title: string;
  venue: string | null;
  year: number | null;
  oaUrl: string | null; // open-access full-text URL if any
  abstract: string;
  citedBy: number;
}

export interface VerifiedRef {
  doi: string;
  title: string;
  year: number | null;
  ieee: string; // formatted IEEE reference string (without the leading [n])
}

function bareDoi(doi: string | null | undefined): string | null {
  if (!doi) return null;
  return doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").trim().toLowerCase();
}

// OpenAlex abstracts come as an inverted index {word: [positions]} — rebuild text.
function reconstructAbstract(inv: Record<string, number[]> | null | undefined): string {
  if (!inv) return "";
  const slots: string[] = [];
  for (const [word, positions] of Object.entries(inv)) {
    for (const p of positions) slots[p] = word;
  }
  return slots.filter(Boolean).join(" ").slice(0, 1500);
}

/** Search OpenAlex for DOI-bearing works on a query. */
export async function openAlexSearch(
  query: string,
  perPage = 8,
  mailto = "linda@example.com",
): Promise<ScholarCandidate[]> {
  const url = new URL(OPENALEX);
  url.searchParams.set("search", query);
  url.searchParams.set("filter", "has_doi:true");
  url.searchParams.set("per_page", String(perPage));
  url.searchParams.set("sort", "relevance_score:desc");
  url.searchParams.set(
    "select",
    "doi,title,publication_year,primary_location,biblio,cited_by_count,open_access,abstract_inverted_index",
  );
  url.searchParams.set("mailto", mailto);

  try {
    const res = await fetch(url, { headers: { "User-Agent": `Linda (${mailto})` } });
    if (!res.ok) {
      log.error("openalex.failed", { status: res.status });
      return [];
    }
    const data = (await res.json()) as { results?: OpenAlexWork[] };
    return (data.results ?? [])
      .map((w): ScholarCandidate | null => {
        const doi = bareDoi(w.doi);
        if (!doi || !w.title) return null;
        return {
          doi,
          title: w.title,
          venue: w.primary_location?.source?.display_name ?? null,
          year: w.publication_year ?? null,
          oaUrl: w.open_access?.oa_url ?? null,
          abstract: reconstructAbstract(w.abstract_inverted_index),
          citedBy: w.cited_by_count ?? 0,
        };
      })
      .filter((c): c is ScholarCandidate => c !== null);
  } catch (err) {
    log.error("openalex.error", { err: err instanceof Error ? err : String(err) });
    return [];
  }
}

/** Verify a DOI on Crossref and build its IEEE reference. Returns null if unresolved. */
export async function crossrefVerify(doi: string, mailto = "linda@example.com"): Promise<VerifiedRef | null> {
  const url = `${CROSSREF}/${encodeURIComponent(doi)}?mailto=${encodeURIComponent(mailto)}`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": `Linda (${mailto})` } });
    if (!res.ok) return null; // 404 → DOI not registered → excluded
    const msg = ((await res.json()) as { message?: CrossrefWork }).message;
    if (!msg) return null;
    return {
      doi,
      title: (msg.title?.[0] ?? "").trim(),
      year: msg.published?.["date-parts"]?.[0]?.[0] ?? msg.issued?.["date-parts"]?.[0]?.[0] ?? null,
      ieee: formatIEEE(msg, doi),
    };
  } catch {
    return null;
  }
}

// ── IEEE reference formatting ─────────────────────────────────────────────────
//  [n] A. B. Author, C. Author, and D. Author, "Title," Venue, vol. X, no. Y,
//      pp. P–Q, Year, doi: 10.xxxx/yyyy.
function formatIEEE(m: CrossrefWork, doi: string): string {
  const authors = formatAuthors(m.author ?? []);
  const title = (m.title?.[0] ?? "Untitled").replace(/\s+/g, " ").trim();
  const venue = (m.container_title?.[0] ?? m["container-title"]?.[0] ?? "").trim();
  const year = m.published?.["date-parts"]?.[0]?.[0] ?? m.issued?.["date-parts"]?.[0]?.[0];

  // Tail fields after the title: venue, vol., no., pp., year.
  const tail: string[] = [];
  if (venue) tail.push(`*${venue}*`);
  if (m.volume) tail.push(`vol. ${m.volume}`);
  if (m.issue) tail.push(`no. ${m.issue}`);
  if (m.page) tail.push(`pp. ${m.page.replace(/-/g, "–")}`);
  if (year) tail.push(String(year));

  // IEEE: Authors, "Title," Venue, vol. X, no. Y, pp. P–Q, Year, doi: ....
  let ref = "";
  if (authors) ref += `${authors}, `;
  ref += `"${title},"`;
  if (tail.length) ref += ` ${tail.join(", ")}`;
  ref += `, doi: ${doi}.`;
  return ref;
}

function formatAuthors(authors: CrossrefAuthor[]): string {
  const names = authors
    .filter((a) => a.family)
    .map((a) => {
      const initials = (a.given ?? "")
        .split(/[\s.-]+/)
        .filter(Boolean)
        .map((p) => `${p[0].toUpperCase()}.`)
        .join(" ");
      return initials ? `${initials} ${a.family}` : (a.family as string);
    });
  if (names.length === 0) return "";
  if (names.length > 6) return `${names.slice(0, 6).join(", ")}, et al.`;
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

// ── External API shapes (trimmed) ─────────────────────────────────────────────
interface OpenAlexWork {
  doi?: string | null;
  title?: string | null;
  publication_year?: number | null;
  primary_location?: { source?: { display_name?: string } | null } | null;
  biblio?: { volume?: string | null; issue?: string | null; first_page?: string | null; last_page?: string | null };
  cited_by_count?: number;
  open_access?: { oa_url?: string | null } | null;
  abstract_inverted_index?: Record<string, number[]> | null;
}

interface CrossrefAuthor {
  given?: string;
  family?: string;
}
interface CrossrefWork {
  author?: CrossrefAuthor[];
  title?: string[];
  container_title?: string[];
  "container-title"?: string[];
  volume?: string;
  issue?: string;
  page?: string;
  published?: { "date-parts"?: number[][] };
  issued?: { "date-parts"?: number[][] };
  type?: string;
}
