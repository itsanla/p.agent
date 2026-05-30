# Ringkasan Teknologi & Penerapan — p.agent (Linda)

**Linda** adalah AI agent pribadi yang menerima & membalas pesan lewat **WhatsApp** dan
**antarmuka web**, ditenagai Groq (multi-key failover), dengan memori jangka panjang.
Arsitektur kini sepenuhnya di **Cloudflare** (sebelumnya Next.js di Vercel).

> Catatan: `claude.md` adalah prompt pembangunan awal (arsitektur lama Vercel) — disimpan
> sebagai arsip. Dokumen **ini** adalah sumber kebenaran arsitektur saat ini.

---

## Arsitektur

```
apps/web  → Next.js static export (out/) di Cloudflare Pages
  /        → chat interaktif        → POST {API}/chat
  /usage   → pemantauan kuota Groq  → GET  {API}/usage (+ /usage/:keyIndex)
  Gate shared-secret (localStorage → header x-linda-secret)

apps/api  → Hono.js di Cloudflare Worker (SEMUA logika backend)
  bindings: DB (D1), VECTORIZE (Vectorize), AI (Workers AI)
  D1 = sumber kebenaran · Upstash Redis = cache · Vectorize = memori semantik
```

## Tech Stack

| Lapisan | Teknologi |
|---|---|
| Backend | **Hono.js** di Cloudflare Worker |
| Frontend | Next.js 16 `output: 'export'` (static) → Cloudflare Pages, React 19 + Tailwind v4 |
| LLM SDK | Vercel AI SDK (`ai`) + `@ai-sdk/groq` (jalan di Worker) |
| Model chat | Groq **Llama 3.3 70B** (utama) · utility/memori **Llama 3.1 8B** |
| Sumber kebenaran | **Cloudflare D1** (Drizzle ORM) |
| Cache | **Upstash Redis** (`@upstash/redis`) — dedup, working-memory, live key-state |
| Memori vektor | **Cloudflare Vectorize** (1024-dim, cosine) |
| Embedding | **Workers AI `@cf/baai/bge-m3`** (1024-dim, multibahasa, di edge) |
| Channel | Meta WhatsApp Cloud API + Web | 
| Tools | Trello (read/write, board tunggal, owner-only) |
| Cron | Cloudflare Cron Trigger (`scheduled`) — reminder Trello via WhatsApp |

## Kapasitas Groq (tervalidasi)

- 15 API key tersedia; **10 aktif, 5 restricted** (anlayx.02–06 → org restricted, di-skip otomatis).
- **6 model** per key (lihat `model.json`), semua callable; limit cocok header live Groq.
- Kapasitas riil = **10 key × 6 model = 60 slot** (bukan 75). Limit harian gabungan per key ≈ 1,7 jt token.
- Manager: deteksi N key dinamis, failover **antar-key** (model tetap, tanpa cross-model),
  tandai 403 (restricted) permanen & 429 (rate limit) dengan backoff. Usage dicatat per **key × model** di D1.

## Pencarian Web & Deep Research (Tavily — tervalidasi)

Dua mode (semua owner-only):
- **Normal** (WhatsApp + web): tool `web_search` (Tavily basic, 1 kredit) + `web_extract` dipanggil
  PROAKTIF oleh model chat (70B) untuk hal aktual/teknis → anti-halusinasi. Skema tool sengaja
  minimal (1 string) karena enum/array membuat tool-calling Llama di Groq gagal ("Failed to call a function").
- **Deep Search** (web saja → jurnal): pipeline custom **DOI-only ketat** di `lib/research.ts`:
  plan (gpt-oss-120b) → discover **OpenAlex** (`has_doi:true`) → verify **Crossref** (hanya DOI yang
  resolve masuk daftar pustaka) → konteks web (Tavily, tak disitasi) → baca abstrak/OA full-text →
  sintesis (Scout, TPM 30k) → tulis manuscript IEEE (70B, TPM 12k — 120B TPM 8k terlalu kecil utk output besar)
  → finalisasi sitasi (keep cited, renumber). Output JSON {title, abstract, keywords, sections[], references[]}.
- Tavily: `TAVILY_API_KEY_*` dinamis (5+), failover 401/429, kredit dilacak bulanan per key di D1
  (`tavily_usage`, dari field `usage`/perhitungan). Sumber ilmiah gratis: OpenAlex + Crossref (polite `mailto`).

### Pemetaan model peran (TPM-aware, failover antar-key)
chat normal = **70B**; utility/memori = **8B**; deep: plan = **gpt-oss-120b**, sintesis = **Scout**,
tulis = **70B**; (safeguard-20b dicadangkan; integrity-check sitasi dilakukan programatik).

## Komponen Utama (`apps/api/src`)

- `index.ts` — Hono routes: webhook WhatsApp (GET verify, POST + HMAC WebCrypto → `waitUntil`),
  `/chat`, `/usage`, `/usage/:keyIndex`, `/usage/tavily`, `/history`, `POST /research`,
  `GET /research/:id` (di-gate secret), `scheduled` cron.
- `lib/groq.ts` — multi-key manager (failover antar-key, usage→D1, state→Redis; 403=restricted,
  413=request-too-large fail-fast, 429=backoff).
- `lib/tavily.ts` — manager Tavily multi-key (search/extract, kredit→D1).
- `lib/scholar.ts` — OpenAlex (discovery) + Crossref (verifikasi DOI) + format IEEE.
- `lib/research.ts` — pipeline deep-research DOI-only (async, status→D1).
- `lib/agent.ts` — inti `generateReply` + `runUpkeep`; gabung web + Trello tools (owner).
- `lib/vector.ts` — Vectorize + bge-m3 (search, store, dedup). Ambang relevansi **0.55**
  (kalibrasi bge-m3 cosine; dedup exact-text via D1 untuk eventual-consistency Vectorize).
- `lib/memory.ts` — ekstraksi fakta + rolling summary (model utility).
- `lib/db.ts` (Drizzle D1), `lib/cache.ts` (Redis), `lib/trello.ts`, `lib/tools.ts`,
  `lib/whatsapp.ts`, `lib/owner.ts`, `lib/system-prompt.ts`, `lib/usage.ts`, `lib/models.ts`.

Frontend: `apps/web/app/research/page.tsx` (submit topik → polling → render manuscript + export
**.doc**/PDF zero-dependency), section kredit Tavily di `/usage`.

## Model Data

```
D1 (sumber kebenaran):
  messages         (riwayat per phone, + key_used/model_used)
  conversations    (metadata per phone, last_inbound utk jendela 24h WA)
  summaries        (rolling summary per phone)
  memory_facts     (teks fakta + id vektor; dedup exact-text)
  usage_counters   PK(date, key_index, model) — token/request Groq harian
  tavily_usage     PK(month, key_index) — kredit Tavily bulanan
  research_tasks   (id, topic, status, stage, manuscript JSON) — deep research async

Vectorize (linda-memory, dim 1024, cosine):
  namespace = {phone}, id = mem:{phone}:{uuid}
  values = embedding bge-m3, metadata = { phone, text, createdAt, kind:"fact" }

Redis (cache, TTL): processed:msg:* (dedup) · chat:hist:* (working memory) ·
  groq:state:* (live rate-limit) · trello:reminded:* (idempotensi reminder)
```

## Environment

**Worker** (`apps/api/.dev.vars` lokal / `wrangler secret put` produksi):
`GROQ_API_KEY_1..15`, `TAVILY_API_KEY_1..N`, `UPSTASH_REDIS_REST_URL/TOKEN`,
`WA_PHONE_NUMBER_ID/ACCESS_TOKEN/APP_SECRET`, `WEBHOOK_VERIFY_TOKEN`, `OWNER_PHONE`,
`TRELLO_API_KEY/TOKEN/BOARD_ID`, `WEB_AUTH_SECRET`, opsional `GROQ_CHAT_MODEL`, `GROQ_UTILITY_MODEL`,
`GROQ_PLAN_MODEL`, `GROQ_SYNTH_MODEL`, `GROQ_WRITE_MODEL`, `SCHOLAR_MAILTO`, `TAVILY_MONTHLY_CREDITS`,
`SYSTEM_PROMPT`, `APP_TIMEZONE`.
Bindings (wrangler.jsonc): `DB`, `VECTORIZE`, `AI`.

**Frontend** (`apps/web/.env`): `NEXT_PUBLIC_API_URL` (URL Worker).

## Menjalankan & Deploy

```bash
# Backend (Worker) — D1 lokal + Vectorize/AI remote
cd apps/api
pnpm install
pnpm db:migrate:local          # atau db:migrate:remote utk produksi
pnpm dev                       # http://localhost:8787

# Frontend
cd apps/web
pnpm install
pnpm dev                       # http://localhost:3000  (/ chat, /usage)
pnpm build                     # → out/ untuk Cloudflare Pages

# Deploy
cd apps/api && pnpm deploy                       # Worker (set secrets dulu)
cd apps/web && pnpm build && npx wrangler pages deploy out
```

Resource Cloudflare (sekali):
`wrangler vectorize create linda-memory --dimensions=1024 --metric=cosine` lalu
`wrangler vectorize create-metadata-index linda-memory --property-name=phone --type=string`.
