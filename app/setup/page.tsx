import Link from "next/link";
import { tenantPage } from "@/lib/who";
import { Logo } from "@/components/Nav";
import { NEAR_RPC_URL, PRIVY_APP_ID } from "@/lib/config";
import { AGENT_FUNDING_NEAR, DAO_DEPOSIT_NEAR, FACTORY, announceSetupCode, setupStatus } from "@/lib/setup";
import { SetupWizard } from "./SetupWizard";

export const dynamic = "force-dynamic";

function Setup() {
  const s = setupStatus();
  if (s.needsCode) announceSetupCode();
  return (
    <div className="mx-auto max-w-2xl pt-6">
      <div className="mb-6"><Logo /></div>
      <div className="card">
        <h1>Set up your treasury</h1>
        <p className="mt-1" style={{ color: "var(--tx-1)" }}>
          Creates a treasury DAO your council controls and an agent account that can only <em>propose</em> payments. Your wallet signs the two steps that cost
          NEAR ({AGENT_FUNDING_NEAR} NEAR for the agent account, {DAO_DEPOSIT_NEAR} NEAR that stays in the DAO); your key never reaches this server.
          {s.network === "testnet" && <strong> Testnet mode: nothing here costs real money.</strong>}
        </p>
        {s.configured ? (
          <div className="mt-4">
            <p className="pos">A treasury is already set up: <span className="mono">{s.dao}</span>.</p>
            <p className="mt-2 text-sm" style={{ color: "var(--tx-1)" }}>Setup only runs before a treasury exists. <Link href="/" style={{ color: "#8c8cff" }}>Go to the Overview</Link> to see who can move the money.</p>
          </div>
        ) : (
          <SetupWizard
            network={s.network} needsCode={s.needsCode} factory={FACTORY} pending={s.pending ?? null}
            privyAppId={PRIVY_APP_ID} rpcUrl={NEAR_RPC_URL} costNear={Number(AGENT_FUNDING_NEAR) + Number(DAO_DEPOSIT_NEAR)}
          />
        )}
      </div>
    </div>
  );
}

export default tenantPage(Setup);
