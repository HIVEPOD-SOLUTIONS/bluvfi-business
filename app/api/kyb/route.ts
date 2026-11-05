import { body, route } from "@/lib/http";
import { refreshBusiness, refreshVendor, startBusinessVerification, startVendorVerification } from "@/lib/kyb";
import { requireSigner } from "@/lib/session";
import { isOwner } from "@/lib/team";

/**
 * Identity verification (KYB). A signer sends a vendor a verification link; the business's owner verifies their own business.
 * `refresh` pulls the decision from Persona now, in case the webhook has not arrived.
 */
export const POST = route(async (req) => {
  const by = await requireSigner(req);
  const b = await body<{ kind?: string; vendor?: string; refresh?: boolean }>(req);
  if (b.kind === "vendor") {
    const name = String(b.vendor ?? "");
    return b.refresh ? { kyb: await refreshVendor(name) } : await startVendorVerification(name);
  }
  if (b.kind === "business") {
    if (!isOwner(by)) throw new Error("Only an owner can verify the business");
    return b.refresh ? { kyb: await refreshBusiness() } : await startBusinessVerification();
  }
  throw new Error("Say whether this is a vendor or the business");
});
