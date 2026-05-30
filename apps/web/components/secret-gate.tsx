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
    return <div className="grid min-h-screen place-items-center text-muted">Memuat...</div>;
  }

  if (!authed) {
    return (
      <div className="grid min-h-screen place-items-center px-6">
        <form onSubmit={submit} className="surface-card w-full max-w-md p-7">
          <div className="mb-4 flex items-center justify-between">
            <span className="badge">Secure Access</span>
            <div className="chip accent">Private</div>
          </div>
          <h1 className="title-display mb-2">Linda Studio</h1>
          <p className="mb-6 text-sm text-muted">
            Masukkan secret untuk membuka konsol pribadi Linda. Setiap sesi akan terenkripsi di
            browser kamu.
          </p>

          <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.2em] text-muted">
            Secret
          </label>
          <input
            type="password"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="WEB_AUTH_SECRET"
            autoFocus
            className="input-field mb-3 w-full"
          />
          {error && <p className="alert mb-4">{error}</p>}
          <button type="submit" disabled={checking || !input.trim()} className="btn-primary w-full">
            {checking ? "Memeriksa..." : "Masuk"}
          </button>
          <p className="mt-4 text-xs text-muted">
            Tips: simpan secret di password manager untuk login cepat.
          </p>
        </form>
      </div>
    );
  }

  return <>{children}</>;
}
