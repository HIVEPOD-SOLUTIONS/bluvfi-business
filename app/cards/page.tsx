import Link from "next/link";
import { PageHead } from "@/components/ui";
import { cardSpentTodayUsd, purchases } from "@/lib/cards";
import { services } from "@/lib/services";
import { currentPolicy, state } from "@/lib/store";
import { approvalThreshold } from "@/lib/team";
import { currentSigner, tenantPage } from "@/lib/who";
import { CardsPanel } from "./CardsPanel";

export const dynamic = "force-dynamic";

async function Cards() {
  const signer = await currentSigner();
  const provider = services.cardProvider();
  const policy = currentPolicy();
  return (
    <>
      <PageHead
        title="Cards"
        sub="One-time cards for purchases behind an ordinary card checkout. Each card is made for one purchase, capped at its amount by the card issuer, handed over once and closed after use. The council's policy decides first, as for any payment."
      />
      {!provider ? (
        <div className="card text-sm grid gap-2" style={{ color: "var(--tx-1)" }}>
          <p>This business has no card provider yet. Its cards come from its own card-issuing account, so they are charged to it and nobody else. An owner connects one on the <Link className="underline" href="/settings">Settings</Link> page:</p>
          <ul className="grid gap-1" style={{ color: "var(--tx-2)" }}>
            <li><strong>Stripe Issuing:</strong> a secret key, a company cardholder, and the signing secret of its authorization webhook (charges are then approved here, one by one).</li>
            <li><strong>Ramp Agent Cards:</strong> an API client and the user whose funds the cards draw on (Ramp&apos;s sandbox to try it).</li>
            <li><strong>Rain</strong> (cards backed by stablecoins): an API key, a user id and Rain&apos;s public key.</li>
          </ul>
        </div>
      ) : (
        <CardsPanel
          provider={provider.name}
          signer={signer ?? ""}
          budget={policy.cardDailyLimitUsd ?? 0}
          spentToday={cardSpentTodayUsd()}
          approvalFrom={policy.approvalThresholdUsd}
          perPayment={policy.perPaymentLimitUsd}
          signersNeeded={approvalThreshold()}
          killSwitch={state().killSwitch}
          purchases={purchases()}
        />
      )}
    </>
  );
}

export default tenantPage(Cards);
