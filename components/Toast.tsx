"use client";
import { useEffect, useState } from "react";

/**
 * A gentle note that something worked (or did not). Anything can call toast("Saved"); the Toaster, mounted once in the layout, shows it
 * for a few seconds and eases it away. Announced politely to screen readers.
 */
const EVENT = "bluvfi:toast";
export function toast(message: string, tone: "ok" | "bad" = "ok") {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(EVENT, { detail: { message, tone } }));
}

interface Item { id: number; message: string; tone: "ok" | "bad"; out?: boolean }

export function Toaster() {
  const [items, setItems] = useState<Item[]>([]);
  useEffect(() => {
    let n = 0;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const later = (fn: () => void, ms: number) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); };
    const onToast = (e: Event) => {
      const { message, tone } = (e as CustomEvent<{ message: string; tone: "ok" | "bad" }>).detail;
      const id = ++n;
      setItems((xs) => [...xs.slice(-2), { id, message, tone }]);
      later(() => setItems((xs) => xs.map((x) => (x.id === id ? { ...x, out: true } : x))), tone === "bad" ? 5200 : 3200);
      later(() => setItems((xs) => xs.filter((x) => x.id !== id)), tone === "bad" ? 5500 : 3500);
    };
    window.addEventListener(EVENT, onToast);
    return () => { window.removeEventListener(EVENT, onToast); timers.forEach(clearTimeout); };
  }, []);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.tone === "bad" ? "toast-bad" : ""} ${t.out ? "out" : ""}`}>
          {t.tone === "ok" ? (
            <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden><circle cx="9" cy="9" r="8" fill="none" stroke="var(--sage)" strokeWidth="1.5" /><path d="M5.2 9.4l2.5 2.5 5-5.4" fill="none" stroke="var(--sage)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
          ) : (
            <span className="neg mono" aria-hidden>!</span>
          )}
          <span>{t.message}</span>
        </div>
      ))}
    </div>
  );
}
