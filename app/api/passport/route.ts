import { body, route } from "@/lib/http";
import { startPassport } from "@/lib/passport";
import { requireSigner } from "@/lib/session";
import { isOwner } from "@/lib/team";

/** A passport check (Self): a signer sends a vendor the link; the business's owner proves their own business. */
export const POST = route(async (req) => {
  const by = await requireSigner(req);
  const b = await body<{ kind?: string; vendor?: string }>(req);
  if (b.kind === "vendor") return startPassport("vendor", String(b.vendor ?? ""));
  if (b.kind === "business") {
    if (!isOwner(by)) throw new Error("Only an owner can verify the business");
    return startPassport("business");
  }
  throw new Error("Say whether this is a vendor or the business");
});
