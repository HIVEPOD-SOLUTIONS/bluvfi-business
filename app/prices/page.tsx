import { PricesTable } from "@/components/PricesTable";
import { PageHead } from "@/components/ui";
import { getMarket, type Market } from "@/lib/prices";
import { services } from "@/lib/services";
import { tenantPage } from "@/lib/who";

export const dynamic = "force-dynamic";

async function Prices() {
  let market: Market | null = null;
  try {
    market = await getMarket(250);
  } catch {
    /* the table asks again, and says why if it still cannot */
  }
  // What the treasury holds that is not a dollar token, so the table can show its worth at today's price.
  const holdings: Record<string, number> = {};
  try {
    for (const b of await services.treasuryBalances()) if (!b.usd) holdings[b.asset] = (holdings[b.asset] ?? 0) + b.amount;
  } catch {
    /* balances are optional here */
  }
  return (
    <>
      <PageHead title="Prices" sub="Live crypto prices, so you know what the treasury and any payment are worth. Prices are for reading only: they never move money." />
      <PricesTable initial={market} holdings={holdings} />
    </>
  );
}

export default tenantPage(Prices);
