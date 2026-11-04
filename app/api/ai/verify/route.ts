import { verifyModelNow } from "@/lib/aimodel";
import { route } from "@/lib/http";
import { requireSigner } from "@/lib/session";

/** A signer checks the private AI model's attestation now (fresh nonce) and registers the keys that pass. No inference is spent. */
export const POST = route(async (req) => {
  await requireSigner(req);
  return { check: await verifyModelNow() };
});
