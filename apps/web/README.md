# p.agent — Personal WhatsApp AI Agent

A personal AI agent that receives and replies to WhatsApp messages via the Meta
Cloud API, powered by **Groq Llama 3.3 70B**. It supports **multiple Groq API
keys with automatic failover** on rate limits, persists chat history per phone
number in **Upstash Redis**, and ships a custom dashboard to monitor token usage
per key and combined.

## Tech Stack

- **Framework**: Next.js (App Router, TypeScript, strict mode)
- **AI**: Vercel AI SDK (`ai`) + `@ai-sdk/groq`
- **Database**: Upstash Redis (`@upstash/redis`)
- **UI**: Tailwind CSS (components built from scratch)
- **Deploy**: Vercel

## Features

- **Multi-key manager with failover** (`lib/groq-manager.ts`) — auto-detects all
  `GROQ_API_KEY_*` env vars, tracks per-key rate-limit headers, prefers the key
  with the most remaining tokens, and fails over on `429` (up to 3 retries).
- **Chat history** in Redis (`lib/redis.ts`) — max 50 messages per number, kept
  in chronological order.
- **WhatsApp webhook** (`app/api/webhook/whatsapp/route.ts`) — verifies Meta's
  challenge, validates the `x-hub-signature-256` HMAC, deduplicates messages,
  responds `200` immediately, then processes replies in the background.
- **Dashboard** (`/`) — per-key token/request gauges with status colors and a
  combined totals card; auto-refreshes every 30s.
- **Conversations** (`/conversations`, `/conversations/[phone]`) — browse chats,
  view full history as bubbles, and clear a conversation.

## Setup

1. **Install dependencies**

   ```bash
   pnpm install
   ```

2. **Configure environment**

   ```bash
   cp .env.example .env.local
   ```

   Fill in the values (see [Environment variables](#environment-variables)).

3. **Run locally**

   ```bash
   pnpm dev
   ```

   The dashboard is at http://localhost:3000.

## Adding more Groq API keys

Keys are detected dynamically — there is **no hardcoded limit**. Just add another
numbered variable and restart:

```env
GROQ_API_KEY_1=gsk_...
GROQ_API_KEY_2=gsk_...
GROQ_API_KEY_4=gsk_...   # gaps are fine; ordered by the numeric suffix
```

Each key gets its own card on the dashboard and joins the failover rotation.

## Setting up the Meta WhatsApp webhook

1. In the [Meta for Developers](https://developers.facebook.com/) console, create
   an app and add the **WhatsApp** product.
2. Note your **Phone Number ID** (`WA_PHONE_NUMBER_ID`) and a **permanent access
   token** (`WA_ACCESS_TOKEN`), and your app's **App Secret** (`WA_APP_SECRET`).
3. Under **WhatsApp → Configuration → Webhook**, set:
   - **Callback URL**: `https://your-app.vercel.app/api/webhook/whatsapp`
   - **Verify token**: the same string as `WEBHOOK_VERIFY_TOKEN`
4. Click **Verify and save** — Meta calls the `GET` handler with `hub.challenge`.
5. **Subscribe** to the `messages` field.

Inbound `text` messages are processed; other types are ignored silently.

## Environment variables

| Variable                  | Required | Description                                              |
| ------------------------- | -------- | -------------------------------------------------------- |
| `GROQ_API_KEY_1`, `_2`, … | yes      | One or more Groq API keys (auto-detected).               |
| `GROQ_MODEL`              | no       | Model override (default `llama-3.3-70b-versatile`).      |
| `UPSTASH_REDIS_REST_URL`  | yes      | Upstash Redis REST URL.                                  |
| `UPSTASH_REDIS_REST_TOKEN`| yes      | Upstash Redis REST token.                                |
| `WA_PHONE_NUMBER_ID`      | yes      | WhatsApp Cloud API phone number ID.                      |
| `WA_ACCESS_TOKEN`         | yes      | Meta Graph API access token.                             |
| `WA_APP_SECRET`           | yes      | Meta app secret (for HMAC signature validation).         |
| `WEBHOOK_VERIFY_TOKEN`    | yes      | Your custom verify token for webhook setup.              |
| `NEXT_PUBLIC_APP_URL`     | no       | Public app URL.                                          |
| `SYSTEM_PROMPT`           | no       | Overrides the default agent system prompt.               |

## Deploy to Vercel

1. Push the repository to GitHub.
2. Import it in [Vercel](https://vercel.com/new).
3. Add every variable above under **Settings → Environment Variables**.
4. Deploy. The webhook route runs on the Node.js runtime with `maxDuration = 60`.
5. Point your Meta webhook Callback URL at
   `https://<your-deployment>/api/webhook/whatsapp`.

## API reference

| Method   | Route                          | Purpose                              |
| -------- | ------------------------------ | ------------------------------------ |
| `GET`    | `/api/webhook/whatsapp`        | Meta webhook verification.           |
| `POST`   | `/api/webhook/whatsapp`        | Receive & process inbound messages.  |
| `GET`    | `/api/stats`                   | Per-key + combined token usage.      |
| `GET`    | `/api/conversations`           | List active conversations.           |
| `GET`    | `/api/conversations/[phone]`   | Full history for a number.           |
| `DELETE` | `/api/conversations/[phone]`   | Clear a conversation.                |
