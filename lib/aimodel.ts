import { checkModel, type ModelCheck } from "./nearai";
import { state } from "./store";

/**
 * Layer 2, step 1: at setup, check the private model's attestation with a fresh nonce and register the signing keys
 * whose Intel TDX, NVIDIA and binding evidence all pass. Every payment still fetches and checks its own attestation;
 * this registry adds whether the key that signed a decision is one already vetted at setup, and it is what the
 * Overview shows as "Private AI model".
 */
export async function verifyModelNow(): Promise<ModelCheck> {
  const check = await checkModel();
  state().aiModel = check;
  return check;
}

const norm = (s: string) => s.toLowerCase().replace(/^0x/, "");
const passed = (s: ModelCheck["signers"][number]) => s.cpu && s.gpu && s.binding && s.nonceBound;

/** Did this key pass the setup-time check? */
export const isRegisteredSigner = (address: string) =>
  !!address && !!state().aiModel?.signers.some((s) => passed(s) && norm(s.signingAddress) === norm(address));

export function modelStatus() {
  const m = state().aiModel;
  if (!m) return { checked: false as const };
  const good = m.signers.filter(passed);
  return { checked: true as const, model: m.model, checkedAt: m.checkedAt, reportHash: m.reportHash, total: m.signers.length, passed: good.length, signers: m.signers };
}
