import { missingHere } from "@/lib/business";
import { mustFind } from "@/lib/agent";
import { orderBill, productDetails, refreshBill, searchProducts } from "@/lib/bills";
import { body, route } from "@/lib/http";
import { cryptorefillsConfigured, listBrands, listProducts, orderCryptorefills, paymentNetworks } from "@/lib/cryptorefills";
import { requireSigner } from "@/lib/session";
import type { Confidentiality } from "@/lib/types";

/**
 * Bills for the signed-in business, from Bitrefill (the default) or Cryptorefills (?provider=cryptorefills). GET searches (?q=…), gives one
 * product's sizes (?product=… for Bitrefill, ?brand=… for Cryptorefills). POST orders a bill (it becomes a payment that the policy and the
 * treasury still decide), or with {refresh} asks where an order stands.
 */
export const GET = route(async (req) => {
  await requireSigner(req);
  const u = new URL(req.url).searchParams;
  if (u.get("provider") === "cryptorefills") {
    const country = u.get("country") ?? "US";
    if (u.get("brand")) return { products: await listProducts(country, u.get("brand")!) };
    return { brands: await listBrands(country, u.get("q") ?? ""), configured: cryptorefillsConfigured(), networks: await paymentNetworks().catch(() => []) };
  }
  if (u.get("product")) return { product: await productDetails(u.get("product")!) };
  return { products: await searchProducts(u.get("q") ?? "", u.get("country") ?? undefined) };
});

export const POST = route(async (req) => {
  const by = await requireSigner(req);
  const b = await body<{ provider?: string; productId?: string; packageValue?: string; email?: string; recipient?: string; confidentiality?: Confidentiality; refresh?: string; country?: string; brand?: string; productValue?: number; beneficiary?: string }>(req);
  if (b.refresh) {
    const p = mustFind(String(b.refresh));
    return { bill: await refreshBill(p) };
  }
  const blocking = missingHere().filter((m) => m.key === "BLUVFI_MASTER_KEY" || m.key === "TREASURY_ACCOUNT");
  if (blocking.length) throw new Error(`Setup incomplete: ${blocking.map((m) => m.key).join(", ")}`);
  const conf: Confidentiality = b.confidentiality === "public" || b.confidentiality === "advanced" ? b.confidentiality : "basic";
  if (b.provider === "cryptorefills") {
    if (!b.productId || !b.brand || !b.country || !b.email || !b.beneficiary) throw new Error("Choose a brand and a product, say who it is for, and give an email for the receipt and the code");
    // Cryptorefills asks who the buyer is, for its fraud checks: the person using this app, as their browser reports it.
    const user = { ip: req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "127.0.0.1", userAgent: req.headers.get("user-agent") ?? "bluvfi-business" };
    const payment = await orderCryptorefills({ country: b.country, brand: b.brand, productId: b.productId, productValue: b.productValue, beneficiary: b.beneficiary, email: b.email, user, confidentiality: conf });
    return { payment, orderedBy: by };
  }
  if (!b.productId || !b.packageValue || !b.email) throw new Error("Choose a product and a size, and give an email for the receipt and the code");
  const payment = await orderBill({ productId: b.productId, packageValue: b.packageValue, email: b.email, recipient: b.recipient, confidentiality: conf });
  return { payment, orderedBy: by };
});
