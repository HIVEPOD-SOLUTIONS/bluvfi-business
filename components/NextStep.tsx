import Link from "next/link";

export interface Step { label: string; done: boolean }

/**
 * One calm answer to "what do I do now?": a single sentence, a single button, and a small bar showing how far along setup is.
 * With nothing left to do it says so, so there is never a question of whether something was missed.
 */
export function NextStep({ steps, title, body, href, cta, calm, kicker }: { steps: Step[]; title: string; body: string; href?: string; cta?: string; calm?: boolean; kicker?: string }) {
  const now = steps.findIndex((s) => !s.done);
  const done = steps.filter((s) => s.done).length;
  return (
    <section className={`card next-step reveal mb-5 ${calm ? "calm" : ""}`} aria-label="What to do next">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0 max-w-xl">
          <p className="label">{calm ? "All clear" : kicker ?? `Next step · ${done} of ${steps.length} done`}</p>
          <h2 className="mt-1">{title}</h2>
          <p className="mt-1 text-sm" style={{ color: "var(--tx-1)" }}>{body}</p>
        </div>
        {href && cta && <Link href={href} className="btn btn-primary attention">{cta} →</Link>}
      </div>
      <div className="progress mt-4" role="img" aria-label={`${done} of ${steps.length} setup steps done`}>
        {steps.map((s, i) => <span key={s.label} className={s.done ? "done" : i === now ? "now" : ""} style={{ "--k": i } as React.CSSProperties} title={s.label} />)}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs" style={{ color: "var(--tx-2)" }}>
        {steps.map((s, i) => <li key={s.label} style={{ color: s.done ? "var(--sage)" : i === now ? "var(--tx-0)" : undefined }}>{s.done ? "✓" : i === now ? "●" : "○"} {s.label}</li>)}
      </ul>
    </section>
  );
}
