import { createPublicKey, verify, type JsonWebKey } from "node:crypto";

/**
 * NVIDIA NRAS returns its GPU verdict as signed JWTs ([["JWT", overall], {"GPU-0": ...}]). Reading the verdict without
 * checking the signature trusts whoever answered the HTTPS call; this checks it ourselves: ES384 against NVIDIA's
 * published keys (JWKS, which rotate about every 12 hours), issuer, expiry, our nonce, and the overall result.
 */
export const NRAS_ISSUER = "https://nras.attestation.nvidia.com";
export const NRAS_JWKS_URL = `${NRAS_ISSUER}/.well-known/jwks.json`;

type Jwk = JsonWebKey & { kid?: string };
let jwksCache: { at: number; keys: Jwk[] } | undefined;

/** Test hook: forget the cached keys. */
export const resetNrasKeys = () => { jwksCache = undefined; };

async function keyFor(kid: string): Promise<Jwk | undefined> {
  const fresh = jwksCache && Date.now() - jwksCache.at < 60 * 60_000;
  let hit = fresh ? jwksCache!.keys.find((k) => k.kid === kid) : undefined;
  if (!hit) {
    // Unknown kid or stale cache: NVIDIA rotates keys, so fetch the current set once more.
    const r = await fetch(NRAS_JWKS_URL, { signal: AbortSignal.timeout(15_000), cache: "no-store" });
    if (!r.ok) throw new Error(`NVIDIA key set returned ${r.status}`);
    jwksCache = { at: Date.now(), keys: ((await r.json()) as { keys: Jwk[] }).keys ?? [] };
    hit = jwksCache.keys.find((k) => k.kid === kid);
  }
  return hit;
}

export interface NrasCheck {
  ok: boolean;
  problems: string[];
  claims: Record<string, unknown>;
}

/** Verifies one NRAS JWT. `nonce` is the nonce we put in the GPU evidence; `now` defaults to the current time. */
export async function verifyNrasJwt(token: string, nonce: string, now = Date.now()): Promise<NrasCheck> {
  const problems: string[] = [];
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, problems: ["not a JWT"], claims: {} };
  const [h, p, s] = parts;
  let header: { alg?: string; kid?: string };
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(h, "base64url").toString());
    claims = JSON.parse(Buffer.from(p, "base64url").toString());
  } catch {
    return { ok: false, problems: ["the token does not decode"], claims: {} };
  }
  if (header.alg !== "ES384") problems.push(`signed with ${header.alg}, expected ES384`);
  const jwk = header.kid ? await keyFor(header.kid) : undefined;
  if (!jwk) problems.push(`signing key ${header.kid ?? "(none)"} is not in NVIDIA's published key set`);
  else {
    const good = verify("sha384", Buffer.from(`${h}.${p}`), { key: createPublicKey({ key: jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
    if (!good) problems.push("signature does not verify against NVIDIA's key");
  }
  if (claims.iss !== NRAS_ISSUER) problems.push(`issuer is ${String(claims.iss)}`);
  if (typeof claims.exp !== "number" || claims.exp * 1000 < now) problems.push("token has expired");
  if (String(claims.eat_nonce ?? "").toLowerCase() !== nonce.toLowerCase().replace(/^0x/, "")) problems.push("token nonce is not ours");
  if (claims["x-nvidia-overall-att-result"] !== true) problems.push("NVIDIA's overall result is not true");
  return { ok: problems.length === 0, problems, claims };
}
