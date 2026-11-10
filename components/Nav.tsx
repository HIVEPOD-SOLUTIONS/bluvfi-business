"use client";
import { ModeSwitch } from "@/components/ModeSwitch";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

/** The menu in three short lists: what you do every day, how you stay in control, and what you can show others. */
const ITEMS = [
  { group: "Every day", href: "/", label: "Overview", icon: "◧" },
  { group: "Every day", href: "/payments", label: "Payments", icon: "⇄" },
  { group: "Every day", href: "/vendors", label: "Vendors", icon: "▤" },
  { group: "Every day", href: "/payroll", label: "Payroll", icon: "☷" },
  { group: "Every day", href: "/bills", label: "Bills", icon: "▦" },
  { group: "Every day", href: "/receivables", label: "Receivables", icon: "↧" },
  { group: "Every day", href: "/cards", label: "Cards", icon: "▭" },
  { group: "Every day", href: "/fund", label: "Fund", icon: "⊕" },
  { group: "Every day", href: "/banking", label: "Bank", icon: "₹" },
  { group: "Every day", href: "/history", label: "History", icon: "≣" },
  { group: "Every day", href: "/prices", label: "Prices", icon: "∿" },
  { group: "Every day", href: "/invest", label: "Invest", icon: "↗" },
  { group: "Every day", href: "/stocks", label: "Stocks", icon: "▲" },
  { group: "Every day", href: "/chat", label: "Ask agent", icon: "✦" },
  { group: "Stay in control", href: "/policy", label: "Policy", icon: "☰" },
  { group: "Stay in control", href: "/team", label: "Team", icon: "☺" },
  { group: "Stay in control", href: "/settings", label: "Settings", icon: "⚙" },
  { group: "Show others", href: "/auditor", label: "Auditor", icon: "✓" },
  { group: "Show others", href: "/proofs", label: "Proofs", icon: "∴" },
  { group: "Show others", href: "/attack", label: "Attack lab", icon: "⚠" },
  { group: "Show others", href: "/check", label: "Check", icon: "◎" },
  { group: "Show others", href: "/ledger", label: "Ledger", icon: "≡" },
];

export function Logo() {
  return (
    <span className="inline-flex items-center gap-2.5">
      <svg width="30" height="30" viewBox="0 0 32 32" aria-hidden>
        <rect width="32" height="32" rx="8" fill="#0000CC" />
        <path d="M11 7v18M11 14c1.2-1.4 2.8-2 4.6-2 3.3 0 5.4 2.2 5.4 5s-2.100 5-5.400 5c-1.800 0-3.400-.6-4.600-2" fill="none" stroke="#fff" strokeWidth="2.600" strokeLinecap="round" />
        <path d="M24 5l2.600 2.600L24 10.200 21.400 7.600z" fill="#C9A84C" />
      </svg>
      <span style={{ fontWeight: 700, letterSpacing: "-0.04em", fontSize: 20 }}>bluvfi</span>
    </span>
  );
}

export function Nav({ signer, demo, owner = false, business, network = "mainnet", operator = false }: { signer: string; demo?: boolean; owner?: boolean; business?: string; network?: string; operator?: boolean }) {
  const path = usePathname();
  // The platform operator also manages the platform's own small wallets (the x402 payer, the confidential test account).
  const items = operator ? ITEMS.flatMap((i) => (i.href === "/settings" ? [i, { group: "Stay in control", href: "/wallets", label: "Wallets", icon: "◈" }] : [i])) : ITEMS;
  const router = useRouter();
  const bar = useRef<HTMLElement>(null);
  // On a phone the bar scrolls sideways: keep the page you are on in view.
  useEffect(() => { bar.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" }); }, [path]);
  const active = (h: string) => (h === "/" ? path === "/" : path.startsWith(h));
  return (
    <>
      <aside className="hidden md:flex fixed inset-y-0 left-0 w-60 flex-col gap-1 overflow-y-auto overscroll-contain p-5 border-r" style={{ background: "var(--bg-1)", borderColor: "var(--bd)" }}>
        <Link href="/" className="mb-1"><Logo /></Link>
        <div className="mb-2 flex items-center gap-2">
          <span className="label" title={business}>{business ? (business.length > 14 ? `${business.slice(0, 13)}…` : business) : "Business"}</span>
          {!demo && <span className="badge badge-gold">{network === "testnet" ? "Testnet" : "Mainnet"}</span>}
        </div>
        <ModeSwitch mode={demo ? "demo" : "live"} owner={owner} />
        {items.map((i, n) => (
          <div key={i.href} className="contents">
            {(n === 0 || items[n - 1].group !== i.group) && <p className="label nav-group">{i.group}</p>}
            <Link
              href={i.href}
              aria-current={active(i.href) ? "page" : undefined}
              className="nav-link flex items-center gap-3 rounded-[10px] px-3 py-2 text-sm font-medium"
              style={{ background: active(i.href) ? "rgba(10,10,232,.16)" : undefined, color: active(i.href) ? "#fff" : "var(--tx-1)" }}
            >
              <span className="nav-icon mono w-4 text-center" style={{ color: active(i.href) ? "#8c8cff" : "var(--tx-2)" }}>{i.icon}</span>
              {i.label}
            </Link>
          </div>
        ))}
        <div className="mt-auto shrink-0 pt-4">
          <p className="text-xs" style={{ color: "var(--tx-2)" }}>Signed in as <span className="mono">{signer}</span></p>
          <button
            className="btn btn-ghost btn-sm mt-2"
            onClick={async () => { await fetch("/api/logout", { method: "POST" }); router.push("/login"); router.refresh(); }}
          >Sign out</button>
          <p className="mt-3 text-xs" style={{ color: "var(--tx-2)" }}>The AI has judgment, never authority.</p>
        </div>
      </aside>

      <nav
        ref={bar}
        className="tabbar md:hidden fixed bottom-0 inset-x-0 z-20 flex border-t px-1 pb-[env(safe-area-inset-bottom)]"
        style={{ background: "var(--bg-2)", borderColor: "var(--bd)" }}
        aria-label="Primary"
      >
        {items.map((i) => (
          <Link
            key={i.href}
            href={i.href}
            aria-current={active(i.href) ? "page" : undefined}
            className="flex flex-col items-center py-2 text-[10px]"
            style={{ color: active(i.href) ? "#8c8cff" : "var(--tx-2)" }}
          >
            <span className="mono text-base leading-none">{i.icon}</span>
            <span className="mt-1 truncate">{i.label}</span>
          </Link>
        ))}
      </nav>
    </>
  );
}
