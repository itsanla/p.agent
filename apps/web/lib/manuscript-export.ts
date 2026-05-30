import type { Manuscript } from "./types";

// Render a manuscript to print-ready HTML, then export to DOCX (client-side via
// @turbodocx/html-to-docx) or PDF (browser print dialog → "Save as PDF"). Both are
// free and run entirely in the browser — no server, no storage.

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Bold a heading's section number prefix and keep inline [n] citations as-is.
function paragraphs(body: string): string {
  return body
    .split(/\n{2,}/)
    .map((p) => `<p style="text-align:justify;margin:0 0 8pt;">${esc(p.trim())}</p>`)
    .join("");
}

/** Build a self-contained HTML document for the manuscript (IEEE-ish layout). */
export function manuscriptToHtml(m: Manuscript): string {
  const keywords = m.keywords.length
    ? `<p><em>Keywords—</em>${esc(m.keywords.join(", "))}</p>`
    : "";
  const sections = m.sections
    .map((s) => `<h2 style="font-size:12pt;margin:14pt 0 6pt;">${esc(s.heading)}</h2>${paragraphs(s.body)}`)
    .join("");
  const refs = m.references
    .map((r) => `<p style="margin:0 0 4pt;text-indent:-18pt;padding-left:18pt;">[${r.n}] ${esc(r.ieee)}</p>`)
    .join("");

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(m.title)}</title>
<style>
  body{font-family:'Times New Roman',Georgia,serif;font-size:11pt;line-height:1.4;color:#000;max-width:720px;margin:24px auto;padding:0 16px;}
  h1{font-size:16pt;text-align:center;margin:0 0 12pt;}
  h2{font-weight:bold;}
  .abstract{font-style:italic;text-align:justify;}
  @media print{body{margin:0;}}
</style></head><body>
  <h1>${esc(m.title)}</h1>
  <p class="abstract"><strong>Abstract—</strong>${esc(m.abstract)}</p>
  ${keywords}
  ${sections}
  <h2 style="font-size:12pt;margin:14pt 0 6pt;">References</h2>
  ${refs}
</body></html>`;
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function safeName(title: string): string {
  return (title || "manuscript").replace(/[^\w\- ]+/g, "").replace(/\s+/g, "_").slice(0, 80);
}

/**
 * Export as an editable Word document (.doc). We wrap the manuscript HTML with
 * the application/msword MIME type — Word, LibreOffice, and Google Docs all open
 * it as an editable document. Zero dependencies and no native modules (a real
 * .docx library transitively pulled in `sharp`, which breaks the static bundle).
 */
export function exportDoc(m: Manuscript): void {
  const html = manuscriptToHtml(m);
  const blob = new Blob(["﻿", html], { type: "application/msword" });
  downloadBlob(blob, `${safeName(m.title)}.doc`);
}

/** Export as PDF via the browser print dialog (user picks "Save as PDF"). */
export function exportPdf(m: Manuscript): void {
  const w = window.open("", "_blank");
  if (!w) return;
  w.document.write(manuscriptToHtml(m));
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 400);
}
