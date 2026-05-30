"use client";

import { useEffect, useState, type ReactNode } from "react";
import { getSecret, setSecret, verifySecret } from "@/lib/api";

// Wraps the app: if no valid secret is stored, prompt for it once. The secret is
// the shared password the Worker checks (WEB_AUTH_SECRET).
export function SecretGate({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [authed, setAuthed] = useState(false);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    const existing = getSecret();
    if (!existing) {
      setReady(true);
      return;
    }
    void verifySecret(existing).then((ok) => {
      setAuthed(ok);
      setReady(true);
    });
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setChecking(true);
    setError(null);
    const ok = await verifySecret(input.trim());
    if (ok) {
      setSecret(input.trim());
      setAuthed(true);
    } else {
      setError("Secret salah atau server tidak dapat dihubungi.");
    }
    setChecking(false);
  }

  if (!ready) {
    return <div className="grid min-h-screen place-items-center text-muted">Memuat…</div>;
  }

  if (!authed) {
    return (
      <div className="grid min-h-screen place-items-center px-4">
        <form onSubmit={submit} className="w-full max-w-sm rounded-xl border border-border bg-surface p-6">
          <div className="mb-1 flex items-center gap-2 text-lg font-semibold">
            <span>⚡</span> Linda
          </div>
          <p className="mb-4 text-sm text-muted">Masukkan secret untuk mengakses Linda.</p>
          <input
            type="password"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="WEB_AUTH_SECRET"
            autoFocus
            className="mb-3 w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-emerald-500"
          />
          {error && <p className="mb-3 text-xs text-red-400">{error}</p>}
          <button
            type="submit"
            disabled={checking || !input.trim()}
            className="w-full rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
          >
            {checking ? "Memeriksa…" : "Masuk"}
          </button>
        </form>
      </div>
    );
  }

  return <>{children}</>;
}
