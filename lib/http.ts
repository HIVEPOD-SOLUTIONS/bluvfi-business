import { NextResponse } from "next/server";
import { persist } from "./store";
import { clientKey, limited } from "./ratelimit";

type Handler<C> = (req: Request, ctx: C) => Promise<Response | unknown> | Response | unknown;

const PER_MINUTE = Number(process.env.RATE_LIMIT_PER_MIN ?? 120);

/** Wrap a route handler: rate limit, JSON in, JSON out, errors become 400s with a plain message. */
export function route<C = unknown>(fn: Handler<C>) {
  return async (req: Request, ctx: C) => {
    const wait = limited(`${clientKey(req)}:${new URL(req.url).pathname}`, PER_MINUTE);
    if (wait) return NextResponse.json({ error: "Too many requests" }, { status: 429, headers: { "retry-after": String(wait) } });
    try {
      const out = await fn(req, ctx);
      if (req.method !== "GET") persist();
      return out instanceof Response ? out : NextResponse.json(out ?? { ok: true });
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 400 });
    }
  };
}

export const body = async <T,>(req: Request): Promise<T> => (await req.json().catch(() => ({}))) as T;
export type Ctx<P extends string> = { params: Promise<Record<P, string>> };
