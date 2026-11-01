/** Fixed-window limiter, per key, in memory. Fine for one process; use a shared store behind several. */
const hits = new Map<string, { n: number; reset: number }>();

export function limited(key: string, max: number, windowMs = 60_000): number {
  const now = Date.now();
  const h = hits.get(key);
  if (!h || h.reset <= now) {
    hits.set(key, { n: 1, reset: now + windowMs });
    if (hits.size > 5000) for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
    return 0;
  }
  h.n += 1;
  return h.n > max ? Math.ceil((h.reset - now) / 1000) : 0;
}

export function clientKey(req: Request): string {
  return (req.headers.get("x-forwarded-for")?.split(",")[0] ?? "local").trim();
}
