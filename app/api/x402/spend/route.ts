import { spendX402 } from "@/lib/agent";
import { body, route } from "@/lib/http";
import { assertPublicUrl } from "@/lib/net-guard";
import { requireSigner } from "@/lib/session";
import { currentBiz, DEFAULT_BIZ } from "@/lib/tenant";

/**
 * The agent pays a paywalled API over x402 from the platform's payer (X402_PAYER_URL), so only the operator's own business
 * may spend from it. The URL must be on the public internet: the server fetches it, and redirects are not followed.
 */
export const POST = route(async (req) => {
  await requireSigner(req);
  if (currentBiz() !== DEFAULT_BIZ) throw new Error("Paying APIs over x402 uses the platform's own payer, so it is only available to the platform operator's business");
  const { url } = await body<{ url?: string }>(req);
  if (!url) throw new Error("Enter the https URL of the paywalled API");
  await assertPublicUrl(url, "The API's URL");
  return spendX402(url);
});
