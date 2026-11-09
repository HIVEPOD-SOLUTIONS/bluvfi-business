import { ModeSwitch } from "@/components/ModeSwitch";
import { Badge, PageHead } from "@/components/ui";
import { bizName, channelStatus } from "@/lib/business";
import { PUBLIC_BASE_URL } from "@/lib/config";
import { isOwner } from "@/lib/team";
import { currentBiz, DEFAULT_BIZ, isDemo } from "@/lib/tenant";
import { currentSigner, tenantPage } from "@/lib/who";
import { BackupSection } from "./BackupSection";
import { BusinessBackupSection } from "./BusinessBackupSection";
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
      <section className="card mb-4"><h2>Demo or live</h2><p className="mt-1 mb-3 text-sm" style={{ color: "var(--tx-1)" }}>Demo uses a simulated DAO and chain with no keys and no funds, and keeps its own records. Live uses the real services and this business&apos;s own treasury. {owner ? "" : "Only an owner can switch."}</p><ModeSwitch mode={isDemo() ? "demo" : "live"} owner={owner} wide /></section>
      {owner && currentBiz() === DEFAULT_BIZ && <BackupSection />}
      {currentBiz() !== DEFAULT_BIZ && <BusinessBackupSection owner={owner} />}
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
