import { propose } from "@/lib/governance";
import { payoutProblem } from "@/lib/intents-tokens";
import { currentPolicy, state } from "@/lib/store";
import { body, route } from "@/lib/http";
import { requireSigner } from "@/lib/session";
import type { Channel, PurchaseOrder, Vendor } from "@/lib/types";

const CHANNELS: Channel[] = ["email", "telegram", "voice"];

/**
 * Vendor master data. The verified contact is the channel used for callbacks, so it must be one you
 * confirmed out of band (a call to a number you already had, the vendor's own Telegram chat with the bot).
 * Setting it is a signer action.
 */
export const POST = route(async (req) => {
  const signer = await requireSigner(req);
  const b = await body<{ vendor?: Partial<Vendor>; purchaseOrder?: PurchaseOrder; proposeAllowlist?: boolean }>(req);
  const s = state();
  if (b.purchaseOrder) {
    const po = b.purchaseOrder;
    if (!po.po || !po.vendorName || !(po.amountUsd > 0)) throw new Error("po, vendorName and a positive amountUsd are required");
    if (!s.vendors.some((v) => v.name === po.vendorName)) throw new Error("Add the vendor first");
    s.purchaseOrders = [...s.purchaseOrders.filter((x) => x.po !== po.po), { po: po.po, vendorName: po.vendorName, amountUsd: po.amountUsd }];
    return { purchaseOrders: s.purchaseOrders };
  }
  const v = b.vendor;
  if (!v?.name || !v.domain || !v.verifiedContact?.handle || !v.payout?.address) throw new Error("name, domain, verified contact and payout address are required");
  if (!CHANNELS.includes(v.verifiedContact.channel)) throw new Error("Unknown contact channel");
  const vendor: Vendor = {
    name: v.name.trim(),
    domain: v.domain.trim().toLowerCase(),
    verifiedContact: { channel: v.verifiedContact.channel, handle: v.verifiedContact.handle.trim() },
    payout: { chain: String(v.payout.chain ?? "near").trim().toLowerCase(), asset: String(v.payout.asset ?? "USDC").trim().toUpperCase(), address: v.payout.address.trim() },
    paidInvoiceNumbers: s.vendors.find((x) => x.name === v.name)?.paidInvoiceNumbers ?? [],
    lastPaidAt: s.vendors.find((x) => x.name === v.name)?.lastPaidAt,
  };
  // A payout destination is checked before it is saved: a chain we pay on, an address in that chain's format, and a stablecoin route.
  const problem = await payoutProblem(vendor.payout.chain, vendor.payout.asset, vendor.payout.address);
  if (problem) throw new Error(`Payout: ${problem}.`);
  s.vendors = [...s.vendors.filter((x) => x.name !== vendor.name), vendor];
  let proposal;
  if (b.proposeAllowlist && !currentPolicy().vendorAllowlist.includes(vendor.name)) {
    const { version, hash, createdAt, ...rest } = currentPolicy();
    void version; void hash; void createdAt;
    proposal = propose({ ...rest, vendorAllowlist: [...rest.vendorAllowlist, vendor.name] }, signer);
  }
  return { vendors: s.vendors, proposal };
});
