import { cookies } from "next/headers";
import { bizName, getBusiness } from "./business";
import { COOKIE, verifySessionFull } from "./session";
import { BIZ_ID, DEFAULT_BIZ, runAs } from "./tenant";

/** The signed-in signer and their business for a server component, or null. */
export async function currentSession(): Promise<{ biz: string; name: string; bizName: string } | null> {
  const s = await verifySessionFull((await cookies()).get(COOKIE)?.value);
  return s ? { ...s, bizName: bizName(s.biz) } : null;
}

/** The signed-in signer for a server component, or null. */
export async function currentSigner(): Promise<string | null> {
  return (await currentSession())?.name ?? null;
}

/** For a public page: the business named by `?b=<id>`, else the signed-in session's, else the operator's own. */
export async function publicBiz(searchParams: Promise<{ b?: string }>): Promise<string> {
  const b = (await searchParams).b;
  if (b && BIZ_ID.test(b) && getBusiness(b)) return b;
  return (await currentSession())?.biz ?? DEFAULT_BIZ;
}

/**
 * Wrap a page so it runs inside its business: the signed-in session's, or, for a public link, the one `pick` reads from
 * the page's props. A page's own code (everything before it returns) reads that business's records.
 */
export function tenantPage<P, Q = P>(fn: (props: P) => Promise<React.ReactNode> | React.ReactNode, pick?: (props: Q) => Promise<string> | string) {
  return async (props: P & Q) => {
    const biz = pick ? await pick(props) : ((await currentSession())?.biz ?? DEFAULT_BIZ);
    return runAs(biz, () => fn(props));
  };
}
