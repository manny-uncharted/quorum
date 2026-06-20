/**
 * On-chain pricing proof — NO funds, NO signing required.
 *
 *   bun run preview
 *
 * Picks the nearest tradable BTC market, builds a real MarketKey, and calls
 * `get_trade_amounts` via devInspect. A non-error result with a real cost is the
 * decisive Day-1 green light: it proves we can construct a valid MarketKey and
 * the contract prices it.
 */

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

import { activeAddress } from "../chain/client.js";
import { fetchTradableMarkets } from "../predict/server.js";
import { fetchOraclePrices, strikeNearForward } from "../predict/oracle.js";
import { fromDusdcRaw, previewTrade, type TradeIntent } from "../predict/market.js";

async function main(): Promise<void> {
  const markets = await fetchTradableMarkets();
  if (markets.length === 0) {
    console.warn("No tradable markets right now — re-run shortly.");
    return;
  }
  // Prefer a market with comfortable time to expiry so it can't settle mid-call.
  const market = markets.find((m) => m.msToExpiry > 30 * 60_000) ?? markets[0]!;

  // devInspect needs a syntactically valid sender; an ephemeral address is fine.
  const sender = activeAddress() ?? Ed25519Keypair.generate().getPublicKey().toSuiAddress();

  // Strikes must sit near the oracle forward, on the tick grid, or pricing aborts.
  const prices = await fetchOraclePrices(market.oracleId);
  const offsetTicks = Number(process.argv[3] ?? "0"); // 0 = ATM
  const strikeRaw = strikeNearForward(
    prices.forwardRaw,
    BigInt(market.raw.tick_size),
    offsetTicks,
  );

  const quantity = BigInt(process.argv[2] ?? "1000000"); // raw contract units
  const intent: TradeIntent = {
    market,
    direction: "up",
    strikeRaw,
    quantity,
  };

  console.log(
    `Market ${market.asset} oracle ${market.oracleId.slice(0, 12)}…  ` +
      `forward ${prices.forward.toLocaleString()}  expires ${market.expiry.toISOString()}`,
  );
  console.log(
    `Quoting UP @ strike ${(Number(strikeRaw) / 1e9).toLocaleString()} ` +
      `(${offsetTicks} ticks OTM), quantity ${quantity} (raw) as ${sender.slice(0, 10)}…\n`,
  );

  const { costRaw, payoutRaw } = await previewTrade(intent, sender);
  console.log(`get_trade_amounts -> (${costRaw}, ${payoutRaw}) raw`);
  // For a binary, max payout per contract ≈ quantity; cost/quantity ≈ implied probability.
  console.log(
    `  amount0 (cost to mint) ≈ ${fromDusdcRaw(costRaw)} DUSDC\n` +
      `  amount1 (complement)   ≈ ${fromDusdcRaw(payoutRaw)} DUSDC` +
      (quantity > 0n
        ? `\n  implied probability ≈ ${((Number(costRaw) / Number(quantity)) * 100).toFixed(1)}%`
        : ""),
  );
  console.log("\n✅ On-chain pricing path verified.");
}

main().catch((err) => {
  console.error("preview failed:", err);
  process.exit(1);
});
