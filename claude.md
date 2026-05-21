# Prompt untuk Claude Opus — AI Agent Coder

Gunakan prompt ini di Claude Opus 4 / Claude Code sebagai instruksi membangun project dari awal.

---

## PROMPT

You are an expert full-stack TypeScript developer. Build a complete production-ready Next.js 15 App Router project with the following specifications. Read every requirement carefully before writing any code.

---

## PROJECT OVERVIEW

A personal AI agent system that:
- Receives and replies to WhatsApp messages via Meta Cloud API webhook
- Uses Groq Llama 3.3 70B as the LLM
- Supports multiple Groq API keys with automatic failover when one hits rate limits
- Stores chat history per WhatsApp phone number in Upstash Redis
- Has a custom-built dashboard UI to monitor token usage per API key and combined total
- Deploys to Vercel

---

## TECH STACK

- **Framework**: Next.js 15 App Router (TypeScript)
- **AI**: Vercel AI SDK (`ai`) + `@ai-sdk/groq`
- **Database**: Upstash Redis (`@upstash/redis`)
- **UI**: Tailwind CSS + Shadcn/ui (build components manually, do NOT use Vercel AI chatbot template)
- **Deploy**: Vercel
- **WhatsApp**: Meta Graph API (WhatsApp Cloud API)

---

## ENVIRONMENT VARIABLES

Create `.env.local` with this structure:

```env
# Groq API Keys (multi-key support)
GROQ_API_KEY_1=gsk_xxxxxxxxxxxxxx
GROQ_API_KEY_2=gsk_xxxxxxxxxxxxxx
GROQ_API_KEY_3=gsk_xxxxxxxxxxxxxx
# Add more as needed: GROQ_API_KEY_4, GROQ_API_KEY_5, etc.

# Upstash Redis
UPSTASH_REDIS_REST_URL=https://xxxxxx.upstash.io
UPSTASH_REDIS_REST_TOKEN=xxxxxx

# Meta WhatsApp Cloud API
WA_PHONE_NUMBER_ID=xxxxxx
WA_ACCESS_TOKEN=xxxxxx
WA_APP_SECRET=xxxxxx
WEBHOOK_VERIFY_TOKEN=your_custom_verify_token_here

# App
NEXT_PUBLIC_APP_URL=https://your-app.vercel.app
```

**Important**: The number of API keys is dynamic. The app must auto-detect all `GROQ_API_KEY_*` variables at runtime. Never hardcode the number of keys.

---

## FEATURE 1 — MULTI API KEY MANAGER WITH FAILOVER

### File: `lib/groq-manager.ts`

Build a `GroqKeyManager` class with these behaviors:

1. **Auto-detect keys**: On startup, read all env vars matching `GROQ_API_KEY_*` pattern. Support unlimited keys.

2. **Track state per key**:
   - `limitRequests`: max requests per day (from response header `x-ratelimit-limit-requests`)
   - `limitTokens`: max tokens per minute (from header `x-ratelimit-limit-tokens`)
   - `remainingRequests`: from header `x-ratelimit-remaining-requests`
   - `remainingTokens`: from header `x-ratelimit-remaining-tokens`
   - `resetRequestsAt`: parsed from header `x-ratelimit-reset-requests`
   - `resetTokensAt`: parsed from header `x-ratelimit-reset-tokens`
   - `isLimited`: boolean, true when key returns 429
   - `limitedUntil`: timestamp when key becomes available again
   - `totalTokensUsed`: running counter of tokens consumed (persisted in Redis)
   - `totalRequestsMade`: running counter of requests made (persisted in Redis)
   - `lastUsed`: timestamp of last successful use

3. **Key selection logic**:
   - Always prefer the key with the most `remainingTokens`
   - Skip keys where `isLimited === true` AND `Date.now() < limitedUntil`
   - If ALL keys are limited, return the one whose `limitedUntil` is nearest (and wait)

4. **After each API call**, update state by parsing response headers:
   ```
   x-ratelimit-limit-requests
   x-ratelimit-limit-tokens
   x-ratelimit-remaining-requests
   x-ratelimit-remaining-tokens
   x-ratelimit-reset-requests   (format: "2m30.5s" or "7.66s")
   x-ratelimit-reset-tokens
   retry-after                  (only on 429)
   ```

5. **Parse reset time strings**: Groq sends times like `"2m30.5s"` or `"45.2s"` — parse these into milliseconds correctly.

6. **On 429 error**:
   - Mark key as `isLimited = true`
   - Set `limitedUntil = Date.now() + (retry-after header * 1000)`
   - Immediately switch to next available key
   - Retry the request with the new key
   - Max 3 retries across all keys before throwing error

7. **Persist usage stats to Redis**: Use keys like:
   - `groq:stats:key1:totalTokens`
   - `groq:stats:key1:totalRequests`
   - `groq:stats:key1:lastUpdated`
   - Reset daily stats at midnight using TTL or timestamp comparison

8. **Export a singleton instance** for use across the app.

### File: `lib/groq-client.ts`

Wrap the manager to expose a simple function:

```typescript
export async function generateAIResponse(
  messages: { role: 'user' | 'assistant'; content: string }[],
  systemPrompt?: string
): Promise<{ text: string; keyUsed: string; tokensUsed: number }>
```

---

## FEATURE 2 — UPSTASH REDIS CHAT HISTORY

### File: `lib/redis.ts`

```typescript
// Redis key structure:
// chat:history:{phoneNumber}    → list of messages (max 50)
// chat:metadata:{phoneNumber}   → { lastActive, totalMessages, name }
// groq:stats:{keyIndex}:*       → token usage stats

export async function getChatHistory(phone: string): Promise<Message[]>
export async function saveChatMessage(phone: string, message: Message): Promise<void>
export async function clearChatHistory(phone: string): Promise<void>
export async function getAllActiveChats(): Promise<ChatMetadata[]>
```

- Store max 50 messages per conversation (use `LPUSH` + `LTRIM`)
- Messages stored as JSON strings
- Include timestamp in each message object
- `getChatHistory` returns messages in chronological order (oldest first)

---

## FEATURE 3 — WHATSAPP WEBHOOK

### File: `app/api/webhook/whatsapp/route.ts`

**GET handler** — Meta webhook verification:
```
hub.mode === 'subscribe' AND hub.verify_token === WEBHOOK_VERIFY_TOKEN
→ respond with hub.challenge
```

**POST handler** — Receive and process messages:

1. **HMAC signature validation** (important for security):
   - Read raw body as text (do NOT call `req.json()` first — you can only read body once)
   - Validate `x-hub-signature-256` header against `sha256(APP_SECRET + rawBody)`
   - Return 403 if invalid

2. **Parse payload** — extract:
   - `phone` (message.from)
   - `messageText` (message.text.body)
   - `messageId` (message.id) — for deduplication
   - `messageType` — only process `type === 'text'`, ignore others silently

3. **Deduplication**: Check Redis key `processed:msg:{messageId}` before processing. If exists, return 200 immediately. If not, set it with 24h TTL.

4. **Respond 200 immediately** to Meta (within 5 seconds requirement), then process async:
   ```typescript
   // Return 200 first
   const response = new Response('OK', { status: 200 });
   
   // Process in background using waitUntil or edge runtime
   processMessage(phone, messageText, messageId); // async, non-blocking
   
   return response;
   ```

5. **processMessage function**:
   - Get chat history from Redis
   - Call `generateAIResponse()` with history + new message
   - Save user message + AI response to Redis
   - Send reply via Meta Graph API
   - Handle errors gracefully (log but don't crash)

6. **Send WhatsApp reply**:
   ```
   POST https://graph.facebook.com/v20.0/{WA_PHONE_NUMBER_ID}/messages
   Authorization: Bearer {WA_ACCESS_TOKEN}
   {
     messaging_product: "whatsapp",
     to: phone,
     type: "text",
     text: { body: replyText }
   }
   ```

Add `export const maxDuration = 60` for Vercel.

---

## FEATURE 4 — DASHBOARD UI

Build a custom dashboard at `app/page.tsx` (and `app/dashboard/page.tsx`).

**Do NOT use any pre-built chat UI library. Build all components from scratch using Tailwind CSS.**

### Layout: `app/layout.tsx`
- Dark theme by default
- Sidebar navigation
- Responsive (mobile + desktop)

### Page 1: Dashboard `/` 

**Token Usage Panel** — the most important UI element:

Display a card for each API key:
```
┌─────────────────────────────────────┐
│ API Key #1  ●  Active               │
│ ...xxxx (last 4 chars of key)       │
├─────────────────────────────────────┤
│ Remaining Tokens (per min)          │
│ ████████████░░░░  8,432 / 6,000     │
│                                     │
│ Remaining Requests (per day)        │
│ ████████████████  892 / 1,000       │
│                                     │
│ Resets in: 2m 14s (tokens)          │
│ Resets in: 18h 42m (requests)       │
├─────────────────────────────────────┤
│ Total Used Today                    │
│ Tokens: 42,841  │  Requests: 108    │
└─────────────────────────────────────┘
```

**Combined Total Card** at the top:
```
┌─────────────────────────────────────┐
│ ALL KEYS COMBINED                   │
│ Total Tokens Available: 18,000/min  │
│ Total Remaining: 14,231             │
│ Active Keys: 3/3                    │
│ Total Requests Today: 324           │
└─────────────────────────────────────┘
```

**Status indicators**:
- 🟢 Green: remaining > 50%
- 🟡 Yellow: remaining 20-50%
- 🔴 Red: remaining < 20% or rate limited

**Auto-refresh**: Fetch `/api/stats` every 30 seconds. Show last updated timestamp.

### Page 2: Conversations `/conversations`

List all active WhatsApp conversations:
- Phone number (masked: `+62 8xx-xxxx-1234`)
- Last message preview
- Last active timestamp
- Total messages count
- Click to view full conversation history

### Page 3: Conversation Detail `/conversations/[phone]`

Show full chat history for a phone number:
- Messages displayed as chat bubbles (user left, AI right)
- Timestamps on each message
- Button to clear conversation history
- Shows which Groq API key was used for each response

---

## FEATURE 5 — STATS API

### File: `app/api/stats/route.ts`

Return JSON with current token usage for all keys:

```typescript
// GET /api/stats
{
  keys: [
    {
      index: 1,
      maskedKey: "...xxxx",
      isLimited: false,
      limitedUntil: null,
      remainingTokens: 8432,
      limitTokens: 6000,
      remainingRequests: 892,
      limitRequests: 1000,
      resetTokensIn: 134000,    // ms
      resetRequestsIn: 67320000, // ms
      totalTokensUsed: 42841,
      totalRequestsMade: 108,
      lastUsed: "2025-05-21T10:23:11Z"
    }
  ],
  combined: {
    totalKeys: 3,
    activeKeys: 3,
    limitedKeys: 0,
    totalRemainingTokens: 14231,
    totalLimitTokens: 18000,
    totalRemainingRequests: 2676,
    totalRequestsToday: 324
  },
  updatedAt: "2025-05-21T10:23:45Z"
}
```

---

## FEATURE 6 — SYSTEM PROMPT

### File: `lib/system-prompt.ts`

```typescript
export const SYSTEM_PROMPT = `
Kamu adalah AI agent pribadi yang cerdas dan membantu.
Kamu menerima pesan melalui WhatsApp.
Jawab dalam bahasa yang sama dengan pesan pengguna (Indonesia atau Inggris).
Berikan jawaban yang ringkas, jelas, dan bermanfaat.
Jika ditanya tentang kemampuanmu, jelaskan bahwa kamu adalah AI agent pribadi berbasis Llama 70B.
`.trim();
```

Make this editable via an environment variable `SYSTEM_PROMPT` that overrides the default.

---

## FILE STRUCTURE

```
├── app/
│   ├── layout.tsx
│   ├── page.tsx                          # Dashboard (token stats)
│   ├── conversations/
│   │   ├── page.tsx                      # List all conversations
│   │   └── [phone]/
│   │       └── page.tsx                  # Conversation detail
│   └── api/
│       ├── webhook/
│       │   └── whatsapp/
│       │       └── route.ts              # Meta webhook handler
│       ├── stats/
│       │   └── route.ts                  # Token usage API
│       └── conversations/
│           ├── route.ts                  # GET all conversations
│           └── [phone]/
│               └── route.ts              # GET/DELETE conversation
├── lib/
│   ├── groq-manager.ts                   # Multi-key manager
│   ├── groq-client.ts                    # Simple wrapper
│   ├── redis.ts                          # Upstash Redis helpers
│   └── system-prompt.ts                  # AI system prompt
├── components/
│   ├── ui/                               # Shadcn components
│   ├── token-card.tsx                    # Per-key usage card
│   ├── combined-stats.tsx                # Combined totals card
│   ├── conversation-list.tsx             # Conversations table
│   └── chat-bubble.tsx                   # Message bubble
├── .env.local
├── .env.example
└── README.md
```

---

## IMPLEMENTATION REQUIREMENTS

1. **TypeScript strict mode** — no `any` types, use proper interfaces everywhere

2. **Error handling** — every async function must have try/catch with meaningful error messages

3. **Groq header parsing** — the reset time format from Groq is like `"2m30.5s"` or `"45.2s"`. Build a robust parser for this format:
   ```typescript
   function parseGroqResetTime(value: string): number {
     // "2m30.5s" → 150500ms
     // "45.2s" → 45200ms
     // "1h2m3s" → handle all combinations
   }
   ```

4. **Vercel deployment considerations**:
   - Serverless functions are stateless — GroqKeyManager state must be partially persisted in Redis
   - The in-memory state is fine for within a single request, but `totalTokensUsed` and `totalRequestsMade` must come from Redis
   - Use `export const runtime = 'nodejs'` (not edge) for the webhook route due to crypto requirements

5. **Security**:
   - Always validate HMAC signature on webhook POST
   - Never expose full API keys in the UI (mask to last 4 chars)
   - Use environment variables for all secrets

6. **README.md** — include:
   - Setup instructions
   - How to add more Groq API keys
   - How to set up Meta webhook
   - Environment variable reference
   - How to deploy to Vercel

---

## PACKAGES TO INSTALL

```bash
pnpm install ai @ai-sdk/groq @upstash/redis
pnpm install tailwindcss @tailwindcss/typography
pnpm dlx shadcn@latest init
pnpm dlx shadcn@latest add card badge progress button table scroll-area separator
```

---

## START

Begin by creating the project structure. Generate ALL files completely — do not leave placeholder comments like `// TODO` or `// implement later`. Every function must be fully implemented.

Start with:
1. `lib/groq-manager.ts` — the most critical file
2. `lib/redis.ts`
3. `app/api/webhook/whatsapp/route.ts`
4. `app/api/stats/route.ts`
5. Dashboard UI files
6. `.env.example` and `README.md`
