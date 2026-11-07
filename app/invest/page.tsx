import { InvestPanel } from "@/components/InvestPanel";
import { PageHead } from "@/components/ui";
import { holdings, listAssets, type Holding, type InvestAsset } from "@/lib/invest";
import { currentPolicy } from "@/lib/store";
import { tenantPage } from "@/lib/who";

export const dynamic = "force-dynamic";

async function Invest() {
  const p = currentPolicy();
  let assets: InvestAsset[] = [];
  let held: Holding[] = [];
  let problem = "";
  try { assets = await listAssets(); } catch (e) { problem = (e as Error).message; }
  try { held = await holdings(); } catch { /* the table says nothing yet; the balance read can fail without stopping the page */ }
  return (
    <>
      <PageHead title="Invest" sub="Put part of the treasury into other coins, held in the treasury's own account. Your council sets which coins and how much; every investment is approved like any payment." />
      {problem && <p role="alert" className="card mb-4 text-sm neg">{problem}</p>}
      <InvestPanel assets={assets} allowed={{ assets: p.investAssets ?? [], maxUsd: p.investMaxUsd ?? 0 }} holdings={held} />
    </>
  );
}

export default tenantPage(Invest);
