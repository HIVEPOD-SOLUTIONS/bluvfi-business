import { body, route } from "@/lib/http";
import { requireSigner } from "@/lib/session";
import { isOwner } from "@/lib/team";
import { currentBiz, DEFAULT_BIZ } from "@/lib/tenant";
import { createWallet, encryptWallet, revealPayerToken, walletsStatus } from "@/lib/wallets";

/**
 * The platform's own small wallets (lib/wallets.ts). Only an owner of the operator's business may see or change them:
 * they belong to the platform, not to any business that signed up. The passphrase comes with each request, is used in
 * memory to seal or open a key file, and is never stored or logged.
 */
async function operator(req: Request) {
  const who = await requireSigner(req);
  if (currentBiz() !== DEFAULT_BIZ || !isOwner(who)) throw new Error("Only the platform operator can manage its wallets.");
  return who;
}

export const GET = route(async (req) => {
  await operator(req);
  return { wallets: await walletsStatus() };
});

export const POST = route(async (req) => {
  await operator(req);
  const b = await body<{ action?: string; id?: string; passphrase?: string }>(req);
  const id = b.id ?? "";
  if (b.action === "create") return createWallet(id, b.passphrase);
  if (b.action === "encrypt") return encryptWallet(id, b.passphrase);
  if (b.action === "token") return revealPayerToken(id, b.passphrase);
  throw new Error("Unknown action");
});
