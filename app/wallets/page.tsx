import { PageHead } from "@/components/ui";
import { isOwner } from "@/lib/team";
import { currentBiz, DEFAULT_BIZ } from "@/lib/tenant";
import { currentSigner, tenantPage } from "@/lib/who";
import { walletsStatus } from "@/lib/wallets";
import { WalletsPanel } from "./WalletsPanel";

export const dynamic = "force-dynamic";

async function Wallets() {
  const signer = await currentSigner();
  const operator = currentBiz() === DEFAULT_BIZ && !!signer && isOwner(signer);
  return (
    <>
      <PageHead
        title="Wallets"
        sub="The platform's two small wallets beside the treasury: the x402 payer that pays for the APIs the agent buys, and a throwaway account for testing a confidential payout. Their keys are encrypted under a passphrase you type here for each action; it is never stored."
      />
      {operator ? (
        <WalletsPanel wallets={await walletsStatus()} />
      ) : (
        <p className="card text-sm" style={{ color: "var(--tx-1)" }}>Only the platform operator (an owner of the business configured in .env.local) can see these wallets.</p>
      )}
    </>
  );
}

export default tenantPage(Wallets);
