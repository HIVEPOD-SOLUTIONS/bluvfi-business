import { approve, cancel, checkSettlement, recordSent, resolveCallback } from "@/lib/agent";
import { body, route, type Ctx } from "@/lib/http";
import { requireSigner } from "@/lib/session";

export const POST = route<Ctx<"id" | "action">>(async (req, { params }) => {
  const { id, action } = await params;
  const signer = await requireSigner(req);
  const b = await body<{ answer?: "yes" | "no"; txRef?: string }>(req);
  if (action === "approve") return { payment: await approve(id, signer) };
  if (action === "cancel") return { payment: cancel(id) };
  if (action === "sent") return { payment: recordSent(id, signer, b.txRef ?? "") };
  if (action === "settlement") return { payment: await checkSettlement(id) };
  // A human recording what the vendor told them (email, or any channel that is not automated).
  if (action === "callback") return { payment: resolveCallback(id, b.answer === "yes" ? "yes" : "no") };
  throw new Error("Unknown action");
});
