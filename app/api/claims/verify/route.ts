import { body, route } from "@/lib/http";
import { clientKey, limited } from "@/lib/ratelimit";
import { issuerPublicKey, publishedRoots, verifyClaim, type ClaimArtifact } from "@/lib/zk-claims";

/**
 * Anyone can check a proof: POST its file. The answer says whether o1js accepts the proof, what it states (decoded from the proof itself),
 * and whether the issuer and OFAC list root it names are this app's. The verifier can add what they require: an issuer they trust, and how
 * many different issuers must have signed. No sign-in: a proof is a public thing, and this holds no secret. Checking takes a second or two of
 * CPU, so each address gets a few checks a minute.
 */
export const POST = route(async (req) => {
  const wait = limited(`verify-proof:${clientKey(req)}`, 12);
  if (wait) throw new Error(`Too many checks from this address. Try again in ${wait} seconds.`);
  const b = await body<{ artifact?: ClaimArtifact; expect?: { trustedIssuer?: unknown; minThreshold?: unknown } } & Partial<ClaimArtifact>>(req);
  const artifact = (b.artifact ?? b) as ClaimArtifact;
  if (!artifact?.proof?.publicInput || !Array.isArray(artifact.proof.publicInput)) throw new Error("That does not look like a proof file. Send the whole file.");
  const trusted = typeof b.expect?.trustedIssuer === "string" && b.expect.trustedIssuer.trim() ? [b.expect.trustedIssuer.trim()] : undefined;
  const minThreshold = Number(b.expect?.minThreshold);
  const v = await verifyClaim(artifact, { trustedIssuers: trusted, minThreshold: Number.isInteger(minThreshold) && minThreshold > 0 ? minThreshold : undefined });
  return {
    ...v,
    createdAt: typeof artifact.createdAt === "string" ? artifact.createdAt : undefined,
    issuerIsThisApp: v.issuers ? v.issuers.includes(await issuerPublicKey()) : undefined,
    distinctIssuers: v.issuers ? new Set(v.issuers).size : undefined,
    listRootIsPublishedHere: v.statement.listRoot ? publishedRoots().includes(v.statement.listRoot) : undefined,
  };
});
