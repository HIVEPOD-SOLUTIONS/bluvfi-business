import { PageHead } from "@/components/ui";
import { StocksPanel } from "@/components/StocksPanel";
import { listStocks, stocksConfigured } from "@/lib/stocks";
import { tenantPage } from "@/lib/who";

export const dynamic = "force-dynamic";

async function Stocks() {
  const stocks = await listStocks().catch(() => null);
  return (
    <>
      <PageHead title="Stocks" sub="US stocks and ETFs on your own Backpack account. The treasury funds it with an approved USDC payment; each trade is capped by the most your council allows for one investment, and can only fill within 1% of the price shown." />
      <StocksPanel configured={stocksConfigured()} initial={stocks} />
    </>
  );
}

export default tenantPage(Stocks);
