/** Fixed-window limiter, per key, in memory. Fine for one process; use a shared store behind several. */
const hits = new Map<string, { n: number; reset: number }>();

export function limited(key: string, max: number, windowMs = 60_000): number {
  const now = Date.now();
  const h = hits.get(key);
  if (!h || h.reset <= now) {
    hits.set(key, { n: 1, reset: now + windowMs });
    if (hits.size > 5000) for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
    if (hits.size > 100_000) hits.clear(); // memory stays bounded whatever arrives
    return 0;
  }
  h.n += 1;
  return h.n > max ? Math.ceil((h.reset - now) / 1000) : 0;
}

/**
 * Who is calling, for rate limits. The first X-Forwarded-For entry is whatever the caller wrote, so it is not used: the entry
 * the nearest trusted proxy appended is (BLUVFI_TRUSTED_PROXY_HOPS proxies in front of the app, default 1; 0 when the app is
 * reached directly, which then counts every caller together).
 */
const HOPS = Number(process.env.BLUVFI_TRUSTED_PROXY_HOPS ?? 1);
export function clientKey(req: Request): string {
  const list = (req.headers.get("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return (HOPS > 0 ? list[list.length - HOPS] : undefined) ?? "local";
}
