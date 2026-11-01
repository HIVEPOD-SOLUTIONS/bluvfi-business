import { spendX402 } from "@/lib/agent";
import { body, route } from "@/lib/http";

export const POST = route(async (req) => {
  const { url } = await body<{ url?: string }>(req);
  if (!url || !/^https:\/\//.test(url)) throw new Error("Enter the https URL of the paywalled API");
  return spendX402(url);
});
