import { sameAddress } from "@/lib/chains";
import { propose } from "@/lib/governance";
import { signerNames } from "@/lib/team";
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
  const b = await body<{ vendor?: Partial<Vendor>; purchaseOrder?: PurchaseOrder; proposeAllowlist?: boolean; confirmChange?: string; discardChange?: string }>(req);
  const s = state();
  // A change to where an existing vendor is paid needs a second signer (see below): confirm or discard it.
  if (b.confirmChange || b.discardChange) {
    const name = String(b.confirmChange || b.discardChange).trim();
    const v = s.vendors.find((x) => x.name === name);
    if (!v?.pendingChange) throw new Error("That vendor has no change waiting");
    if (b.confirmChange) {
      if (v.pendingChange.by === signer && signerNames().length > 1) throw new Error("A different signer must confirm a change you made");
      v.payout = v.pendingChange.payout;
      v.verifiedContact = v.pendingChange.verifiedContact;
    }
    delete v.pendingChange;
    return { vendors: s.vendors };
  }
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
  const name = v.name.trim();
  const existing = s.vendors.find((x) => x.name === name);
  const vendor: Vendor = {
    name,
    domain: v.domain.trim().toLowerCase(),
    verifiedContact: { channel: v.verifiedContact.channel, handle: v.verifiedContact.handle.trim() },
    payout: { chain: String(v.payout.chain ?? "near").trim().toLowerCase(), asset: String(v.payout.asset ?? "USDC").trim().toUpperCase(), address: v.payout.address.trim() },
    paidInvoiceNumbers: existing?.paidInvoiceNumbers ?? [],
    lastPaidAt: existing?.lastPaidAt,
    kyb: existing?.kyb,
    passport: existing?.passport,
  };
  // A payout destination is checked before it is saved: a chain we pay on, an address in that chain's format, and a stablecoin route.
  const problem = await payoutProblem(vendor.payout.chain, vendor.payout.asset, vendor.payout.address);
  if (problem) throw new Error(`Payout: ${problem}.`);
  // One signer may add a vendor, but not redirect an existing one's money or the channel that confirms changes: that waits
  // for a second signer, and payments keep using the current details until then. (A business with one signer has nobody to ask.)
  const redirects = existing && (
    existing.payout.chain !== vendor.payout.chain || existing.payout.asset !== vendor.payout.asset || !sameAddress(existing.payout.address, vendor.payout.address)
    || existing.verifiedContact.channel !== vendor.verifiedContact.channel || existing.verifiedContact.handle !== vendor.verifiedContact.handle);
  if (existing && redirects && signerNames().length > 1) {
    vendor.payout = existing.payout;
    vendor.verifiedContact = existing.verifiedContact;
    vendor.pendingChange = { payout: { chain: b.vendor!.payout!.chain ? String(b.vendor!.payout!.chain).trim().toLowerCase() : existing.payout.chain, asset: String(b.vendor!.payout!.asset ?? existing.payout.asset).trim().toUpperCase(), address: b.vendor!.payout!.address!.trim() }, verifiedContact: { channel: v.verifiedContact.channel, handle: v.verifiedContact.handle.trim() }, by: signer, at: new Date().toISOString() };
  } else if (existing?.pendingChange) {
    vendor.pendingChange = existing.pendingChange;
  }
  s.vendors = [...s.vendors.filter((x) => x.name !== vendor.name), vendor];
  let proposal;
  if (b.proposeAllowlist && !currentPolicy().vendorAllowlist.includes(vendor.name)) {
    const { version, hash, createdAt, ...rest } = currentPolicy();
    void version; void hash; void createdAt;
    proposal = propose({ ...rest, vendorAllowlist: [...rest.vendorAllowlist, vendor.name] }, signer);
  }
  return { vendors: s.vendors, proposal };
});
