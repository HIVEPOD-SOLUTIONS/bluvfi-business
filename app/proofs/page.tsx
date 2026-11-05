import { ClaimForms, ClaimList } from "@/components/Claims";
import { Empty, PageHead } from "@/components/ui";
import { kybEnabled } from "@/lib/kyb";
import { state } from "@/lib/store";
import { currentBiz } from "@/lib/tenant";
import { tenantPage } from "@/lib/who";
import { attesters, attestThreshold, claimsFor, issuerPublicKey } from "@/lib/zk-claims";
import { AnchorBox } from "@/components/Claims";

export const dynamic = "force-dynamic";

async function Proofs() {
  const claims = claimsFor(currentBiz());
  return (
    <>
      <PageHead
        title="Proofs"
        sub="Zero-knowledge proofs: each one states a single true thing and keeps the rest secret. They are files anyone can verify, with no trust in this app beyond the issuer's key and the public OFAC list."
      />
      <ClaimForms vendors={state().vendors.map((v) => v.name)} kybOn={kybEnabled()} />
      <h2 className="mt-8 mb-3">Who attests</h2>
      <AnchorBox attesters={attesters().length} threshold={attestThreshold()} />
      <h2 className="mt-8 mb-3">Your proofs</h2>
      {claims.length === 0 ? <Empty title="No proofs yet" hint="Ask for one above. Making a proof takes about half a minute." /> : <ClaimList claims={claims.map(({ id, kind, label, createdAt, status, error }) => ({ id, kind, label, createdAt, status, error }))} />}
      <p className="mt-6 text-sm" style={{ color: "var(--tx-2)" }}>
        Anyone can check a proof, with no account, on the <a className="underline" href="/verify-proof">Check a proof</a> page (send them that link), or with <span className="mono">npm run zk:claim:verify -- proof.json</span>.
        Credentials and balances are attested by this app&apos;s issuer key <span className="mono break-all">{await issuerPublicKey()}</span>.
      </p>
    </>
  );
}

export default tenantPage(Proofs);
