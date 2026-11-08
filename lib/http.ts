import { NextResponse } from "next/server";
import { refreshState, withRecords } from "./store";
import { clientKey, limited } from "./ratelimit";
import { cookieFrom, verifySessionFull } from "./session";
import { DEFAULT_BIZ, runAs } from "./tenant";

type Handler<C> = (req: Request, ctx: C) => Promise<Response | unknown> | Response | unknown;

const PER_MINUTE = Number(process.env.RATE_LIMIT_PER_MIN ?? 120);

/**
 * Wrap a route handler: rate limit, JSON in, JSON out, errors become 400s with a plain message. The handler runs inside
 * the business of the signed-in session, or, for a public link, the business `scope` says the link belongs to.
 */
export function route<C = unknown>(fn: Handler<C>, scope?: (req: Request, ctx: C) => Promise<string> | string) {
  return async (req: Request, ctx: C) => {
    const wait = limited(`${clientKey(req)}:${new URL(req.url).pathname}`, PER_MINUTE);
    if (wait) return NextResponse.json({ error: "Too many requests" }, { status: 429, headers: { "retry-after": String(wait) } });
    try {
      const biz = scope ? await scope(req, ctx) : ((await verifySessionFull(cookieFrom(req)))?.biz ?? DEFAULT_BIZ);
      return await runAs(biz, async () => {
        // A read sees the latest records; a write has the business's records to itself until it is saved (lib/store.ts).
        let out: unknown;
        if (req.method === "GET") {
          refreshState();
          out = await fn(req, ctx);
        } else {
          out = await withRecords(() => fn(req, ctx));
        }
        return out instanceof Response ? out : NextResponse.json(out ?? { ok: true });
      });
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 400 });
    }
  };
}

export const body = async <T,>(req: Request): Promise<T> => (await req.json().catch(() => ({}))) as T;
export type Ctx<P extends string> = { params: Promise<Record<P, string>> };
