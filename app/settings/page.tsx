import { Badge, PageHead } from "@/components/ui";
import { bizName, channelStatus } from "@/lib/business";
import { PUBLIC_BASE_URL } from "@/lib/config";
import { isOwner } from "@/lib/team";
import { currentBiz, DEFAULT_BIZ } from "@/lib/tenant";
import { currentSigner, tenantPage } from "@/lib/who";
import { ChannelsEditor } from "./ChannelsEditor";

export const dynamic = "force-dynamic";

async function Settings() {
  const signer = (await currentSigner()) ?? "";
  const owner = isOwner(signer);
  const st = channelStatus(currentBiz(), owner);
  const q = currentBiz() === DEFAULT_BIZ ? "" : `?b=${currentBiz()}`;
  return (
    <>
      <PageHead
        title="Settings"
        sub={`${bizName()}: the channels this business uses to reach its vendors, and what its Check service earns. Each business brings its own, so replies and money stay with it.`}
        right={<Badge tone={owner ? "gold" : "default"}>{owner ? "Owner" : "View only"}</Badge>}
      />
      {!PUBLIC_BASE_URL && <p role="alert" className="card mb-4 text-sm" style={{ color: "var(--tx-1)" }}>The platform has no PUBLIC_BASE_URL set, so Telegram and voice callbacks cannot reach it yet.</p>}
      <ChannelsEditor
        owner={owner}
        status={st}
        urls={{ check: `/api/check${q}`, ledger: `/ledger${q}`, poll: `/api/agentmarket/poll${q}`, stripeCards: `${PUBLIC_BASE_URL || ""}/api/cards/stripe${q}` }}
      />
    </>
  );
}

export default tenantPage(Settings);
