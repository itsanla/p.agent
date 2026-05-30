"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

const NAV = [
  { href: "/", label: "Chat", icon: "💬" },
  { href: "/research", label: "Deep Research", icon: "🔬" },
  { href: "/usage", label: "Usage", icon: "📊" },
];

export function Sidebar() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));

  return (
    <>
      {/* Mobile top bar */}
      <div className="flex items-center justify-between border-b border-border bg-surface px-4 py-3 md:hidden">
        <span className="font-semibold">⚡ Linda</span>
        <button
          onClick={() => setOpen((v) => !v)}
          className="rounded-md border border-border px-3 py-1 text-sm text-muted"
          aria-label="Toggle navigation"
        >
          ☰
        </button>
      </div>

      <aside
        className={`${
          open ? "block" : "hidden"
        } w-full shrink-0 border-b border-border bg-surface md:block md:w-60 md:border-b-0 md:border-r`}
      >
        <div className="hidden items-center gap-2 px-6 py-5 md:flex">
          <span className="text-xl">⚡</span>
          <span className="text-lg font-semibold tracking-tight">Linda</span>
        </div>
        <nav className="flex flex-col gap-1 p-3">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setOpen(false)}
              className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
                isActive(item.href)
                  ? "bg-surface-2 text-foreground"
                  : "text-muted hover:bg-surface-2 hover:text-foreground"
              }`}
            >
              <span className="text-base">{item.icon}</span>
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="hidden px-6 py-4 text-xs text-muted md:block">
          Asisten pribadi
          <br />
          WhatsApp · Web · Trello
        </div>
      </aside>
    </>
  );
}
