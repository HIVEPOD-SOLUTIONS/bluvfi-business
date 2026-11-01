import { cookies } from "next/headers";
import { COOKIE, verifySession } from "./session";

/** The signed-in signer for a server component, or null. */
export async function currentSigner(): Promise<string | null> {
  return verifySession((await cookies()).get(COOKIE)?.value);
}
