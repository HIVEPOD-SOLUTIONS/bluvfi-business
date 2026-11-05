import { body, route } from "@/lib/http";
import { requireSigner } from "@/lib/session";
import { currentBiz } from "@/lib/tenant";
import { anchorIssuers, anchorStatus } from "@/lib/zk-anchor";
import { claimsFor, prepareCircuit, prepareCredential, prepareName, prepareSanctions, prepareSolvency, startClaim, subjectOf, type GateInput } from "@/lib/zk-claims";
import { randomBytes } from "node:crypto";

/**
 * Zero-knowledge claims. GET lists this business's claims. POST asks for one: the app prepares the private part (checks the payee against the
 * OFAC list, reads the balances, finds the verified credential), then a separate process proves it, and the claim turns "done" when the proof
 * exists. The private part is deleted as soon as the proof is made.
 */
export const GET = route(async (req) => {
  await requireSigner(req);
  return { claims: claimsFor(currentBiz()) };
});

export const POST = route(async (req) => {
  await requireSigner(req);
  const b = await body<{ kind?: string; address?: string; name?: string; vendor?: string; minUsd?: number; gates?: GateInput[]; maxQubits?: number; maxToffoli?: number; subject?: string }>(req);
  // The subject ties a proof to one thing (a payment id, say), so it cannot be reused for another.
  const subject = subjectOf(String(b.subject ?? `${currentBiz()}:${b.kind}:${randomBytes(8).toString("hex")}`));
  switch (b.kind) {
    case "sanctions":
      return { claim: await startClaim(await prepareSanctions(String(b.address ?? "").trim(), subject)) };
    case "name":
      return { claim: await startClaim(await prepareName(String(b.name ?? "").trim(), subject)) };
    case "vendor":
      return { claim: await startClaim(await prepareCredential("vendor", String(b.vendor ?? ""), subject)) };
    case "business":
      return { claim: await startClaim(await prepareCredential("business", undefined, subject)) };
    case "solvency":
      return { claim: await startClaim(await prepareSolvency(Number(b.minUsd), subject)) };
    case "circuit": {
      if (!Array.isArray(b.gates)) throw new Error("Give the circuit as a list of gates");
      for (const g of b.gates) if (![1, 2, 3].includes(g.kind) || ![g.a, g.b ?? 0, g.c ?? 0].every((q) => Number.isInteger(q) && q >= 0 && q < 65536)) throw new Error("Each gate needs a kind of 1, 2 or 3 and whole-number qubits");
      return { claim: await startClaim(await prepareCircuit(b.gates, Number(b.maxQubits), Number(b.maxToffoli), subject)) };
    }
    case "anchor":
      return { anchor: await anchorIssuers() };
    case "anchor-status":
      return { anchor: await anchorStatus() };
    default:
      throw new Error("Choose sanctions, name, vendor, business, solvency, circuit, anchor or anchor-status");
  }
});
