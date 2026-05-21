# Ringkasan Teknologi & Penerapan — p.agent (Linda)

Ringkasan teknis arsitektur dan teknologi yang diterapkan pada project ini.
**Linda** adalah AI agent pribadi yang menerima & membalas pesan WhatsApp,
ditenagai Groq Llama 3.3 70B, dengan manajemen konteks/memori jangka panjang.

---

## Tech Stack

| Lapisan | Teknologi | Versi |
|---|---|---|
| Framework | Next.js (App Router, TypeScript strict) | 16.2.6 |
| UI | React + Tailwind CSS (komponen dibuat manual) | 19.2 / v4 |
| LLM SDK | Vercel AI SDK (`ai`) + `@ai-sdk/groq` | 6.x / 3.x |
| Model | Groq **Llama 3.3 70B** (chat) + Llama 3.1 8B (opsional util) | — |
| Database | Upstash Redis (`@upstash/redis`) | 1.38 |
| Vector DB | Upstash Vector (`@upstash/vector`), embedding **BGE-M3** | 1.2 |
| Deploy | Vercel (runtime Node.js) | — |
| Channel | Meta WhatsApp Cloud API (Graph API v20.0) | — |

---

## Komponen Utama

### 1. Multi-key Groq Manager dengan Failover (`lib/groq-manager.ts`)
- Auto-deteksi semua env `GROQ_API_KEY_*` (jumlah dinamis, tanpa batas hardcode).
- Memilih key dengan sisa token terbanyak; **failover otomatis saat 429** (maks 3 retry lintas-key).
- Parsing header rate-limit Groq (`x-ratelimit-*`, format `"2m30.5s"`) → ms.
- Statistik token/permintaan per key dipersistensi di Redis (date-stamped, TTL 48 jam = reset harian).
- Opsi `model` & `temperature` per panggilan; batas output token (`GROQ_MAX_OUTPUT_TOKENS`, default 2048).
- Singleton lintas request dalam satu instance serverless.

### 2. Webhook WhatsApp (`app/api/webhook/whatsapp/route.ts`)
- **GET**: verifikasi challenge Meta (`hub.verify_token`).
- **POST**: validasi **HMAC `x-hub-signature-256`** terhadap `WA_APP_SECRET`, dedup pesan,
  balas `200` cepat lalu proses di background (`after()`), kirim balasan via Graph API.
- Runtime Node.js, `maxDuration = 60`.

### 3. Manajemen Konteks & Memori (bertingkat 3 lapis)
Pola modern (mirip mem0/Zep) — **hanya kirim konteks relevan**, hemat token:
- **Working memory** — 20 pesan terakhir verbatim dari Redis list (maks 50 per nomor).
- **Rolling summary** — ringkasan berkelanjutan di Redis (`chat:summary:{phone}`), diperbarui berkala.
- **Long-term semantic** (`lib/memory.ts` + `lib/vector.ts`) — fakta diekstrak tiap giliran,
  disimpan di Upstash Vector (BGE-M3, multibahasa, **0 token Groq**), di-namespace per nomor.
  Retrieval semantik top-8 dengan ambang relevansi 0.75 (anti-halusinasi) + dedup 0.9.
- Semua dikunci ke **nomor pengirim** (`message.from`); tahan ganti API key & nomor bisnis;
  fakta tanpa kedaluwarsa → bisa mengingat percakapan lama.

### 4. Dashboard & API
- `/` — pemantauan token per key + gabungan, auto-refresh 30 detik (`/api/stats`).
- `/conversations` & `/conversations/[phone]` — daftar & detail percakapan, hapus riwayat.
- API: `/api/stats`, `/api/conversations`, `/api/conversations/[phone]` (GET/DELETE).

### 5. Observabilitas (`lib/logger.ts`)
- Event log ke `logs/next.log` + console untuk setiap tahap logika WhatsApp
  (verify, signature, AI, memory.search/extract, send) — sukses & error.

---

## Model Data

```
Redis:
  chat:history:{phone}     → list pesan (JSON, maks 50, urut terbaru di depan)
  chat:metadata:{phone}    → { lastActive, totalMessages, name, lastMessage }
  chat:summary:{phone}     → ringkasan berkelanjutan
  chat:index               → set semua nomor aktif
  processed:msg:{id}       → penanda dedup (TTL 24 jam)
  groq:stats:{tgl}:key{n}  → statistik token/permintaan (TTL 48 jam)

Upstash Vector (dim 1024, COSINE, BGE-M3):
  namespace = {phone}
  id        = mem:{phone}:{uuid}
  data      = teks fakta   (di-embed otomatis)
  metadata  = { phone, createdAt, kind: "fact" }
```

---

## Variabel Environment

| Variabel | Wajib | Keterangan |
|---|---|---|
| `GROQ_API_KEY_1..N` | ya | Satu/lebih Groq API key (auto-deteksi). |
| `GROQ_MODEL` | tidak | Override model chat (default `llama-3.3-70b-versatile`). |
| `GROQ_MEMORY_MODEL` | tidak | Model ekstraksi/ringkasan memori. |
| `GROQ_MAX_OUTPUT_TOKENS` / `GROQ_CHAT_TEMPERATURE` | tidak | Kontrol panjang & kreativitas balasan. |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | ya | Upstash Redis. |
| `UPSTASH_VECTOR_REST_URL` / `_TOKEN` | tidak | Upstash Vector (memori jangka panjang; kosong = nonaktif). |
| `WA_PHONE_NUMBER_ID` / `WA_ACCESS_TOKEN` / `WA_APP_SECRET` / `WEBHOOK_VERIFY_TOKEN` | ya | Meta WhatsApp Cloud API. |
| `APP_TIMEZONE` | tidak | Zona waktu kesadaran waktu prompt (default `Asia/Jakarta`). |

---

## Roadmap (belum diterapkan)

- **Fase 3 memori**: konsolidasi & decay (perbarui fakta yang berubah, expire usang) + UI memori di dashboard.
- **Tool calling**: integrasi read/write Trello, Google Calendar/Drive/Gmail, Zoho Mail
  (single-owner, allowlist nomor pemilik, konfirmasi untuk aksi menulis).
