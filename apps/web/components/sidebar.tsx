"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

const NAV = [
  {
    href: "/",
    label: "Chat Studio",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden="true">
        <path
          d="M7 12h10M7 8h6M6 20l-2 2V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-3 3z"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    href: "/research",
    label: "Deep Research",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden="true">
        <path
          d="M10 3h4M4 7h16M6 7l1.4 12.4a2 2 0 0 0 2 1.6h5.2a2 2 0 0 0 2-1.6L18 7"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path d="M9 11h6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    href: "/usage",
    label: "Usage Meter",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden="true">
        <path
          d="M4 18h16M6 18V9m6 9V6m6 12v-5"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
];

export function Sidebar() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));

  return (
    <>
      {/* Mobile top bar */}
      <div className="mobile-bar md:hidden">
        <div className="flex items-center gap-3">
          <div className="brand-orb">L</div>
          <div>
            <div className="text-sm font-semibold tracking-tight">Linda Studio</div>
            <div className="text-xs text-muted">Personal AI Agent</div>
          </div>
        </div>
        <button
          onClick={() => setOpen((v) => !v)}
          className="nav-toggle"
          aria-label="Toggle navigation"
        >
          Menu
        </button>
      </div>

      <aside
        className={`${open ? "block" : "hidden"} sidebar shrink-0 md:block`}
      >
        <div className="hidden items-center gap-3 px-5 pt-6 md:flex">
          <div className="brand-orb">L</div>
          <div>
            <div className="text-base font-semibold tracking-tight">Linda Studio</div>
            <div className="text-xs text-muted">Personal AI Agent</div>
          </div>
        </div>

        <div className="sidebar-card">
          <div className="eyebrow">Status</div>
          <div className="mt-2 flex items-center gap-2 text-sm font-semibold">
            <span className="status-dot" />
            Live session
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <span className="chip accent">WA sync</span>
            <span className="chip">Auto save</span>
          </div>
        </div>

        <nav className="nav-list">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setOpen(false)}
              className={`nav-item ${isActive(item.href) ? "active" : ""}`}
            >
              {item.icon}
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="sidebar-footer hidden md:block">
          <div className="mb-2">Asisten pribadi</div>
          <div className="text-xs">WhatsApp · Web · Trello</div>
        </div>
      </aside>
    </>
  );
}
