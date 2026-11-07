import { ChatPanel } from "@/components/ChatPanel";
import { PageHead } from "@/components/ui";
import { NEAR_AI_KEY } from "@/lib/config";
import { tenantPage } from "@/lib/who";

export const dynamic = "force-dynamic";

async function Chat() {
  return (
    <>
      <PageHead title="Ask the agent" sub="Say what you want in your own words: prices, balances, history, a bill, an investment, a payment. The agent finds what it can and puts anything that spends money in front of you to confirm. It never decides." />
      {!NEAR_AI_KEY && <p role="alert" className="card mb-4 text-sm" style={{ color: "var(--amber)" }}>The agent needs NEAR_AI_API_KEY to understand what you write. Everything else in the app works without it.</p>}
      <ChatPanel />
    </>
  );
}

export default tenantPage(Chat);
