/**
 * Settlement — close out expired positions and book realized P&L.
 *
 *   bun run settle                       # settle against real settled oracles
 *   bun run settle --simulate-price 65000  # force-settle open positions (paper demo)
 *
 * For each open position whose oracle has settled, computes the binary outcome
 * (UP wins if settlement > strike) and books P&L. Testnet positions are also
 * redeemed on-chain to claim funds (best-effort; logged).
 */

import { Transaction } from "@mysten/sui/transactions";

import { client, loadKeypair } from "../chain/client.js";
import { fetchMarkets, findMarket } from "../predict/server.js";
import { addRedeem } from "../predict/market.js";
import { Portfolio, type Position } from "../desk/portfolio.js";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Best-effort on-chain redemption of a testnet position; logged, never throws. */
async function redeemOnChain(p: Position): Promise<void> {
  const managerId = process.env.PREDICT_MANAGER_ID?.trim();
  if (!managerId) return;
  const market = await findMarket(p.oracleId);
  if (!market) {
    console.log(`   (redeem skipped: market ${p.oracleId.slice(0, 10)}… not found)`);
    return;
  }
  try {
    const tx = new Transaction();
    addRedeem(tx, managerId, {
      market,
      direction: p.direction,
      strikeRaw: BigInt(p.strikeRaw),
      quantity: BigInt(p.quantity),
    });
    const res = await client.signAndExecuteTransaction({
      signer: loadKeypair(),
      transaction: tx,
      options: { showEffects: true },
    });
    await client.waitForTransaction({ digest: res.digest });
    console.log(`   redeem tx ${res.digest} → ${res.effects?.status?.status}`);
  } catch (e) {
    console.log(`   redeem failed (best-effort): ${e}`);
  }
}

async function main(): Promise<void> {
  const portfolio = await Portfolio.open();
  const release = await portfolio.lock();
  let open = [];
  try {
    await portfolio.reload();
    open = portfolio.open_();
  } finally {
    await release();
  }
  if (open.length === 0) {
    console.log("No open positions to settle.");
    return;
  }
  console.log(`${open.length} open position(s).`);

  const simulatePrice = flag("simulate-price");
  const byOracle = new Map<string, number>(); // oracleId -> settlement price

  if (simulatePrice != null) {
    const price = Number(simulatePrice);
    for (const p of open) byOracle.set(p.oracleId, price);
    console.log(`Simulating settlement at price ${price.toLocaleString()} for all open oracles.`);
  } else {
    const markets = await fetchMarkets();
    for (const p of open) {
      const m = markets.find((x) => x.oracleId === p.oracleId);
      if (m && m.status === "settled" && m.settlementPrice != null) {
        byOracle.set(p.oracleId, m.settlementPrice);
      }
    }
    if (byOracle.size === 0) {
      console.log("No open positions have settled yet.");
      return;
    }
  }

  let totalPnl = 0;
  for (const [oracleId, price] of byOracle) {
    const settled = await portfolio.settleOracle(oracleId, price);
    for (const p of settled) {
      totalPnl += p.realizedPnlUsd ?? 0;
      console.log(
        `  ${p.asset} ${p.direction.toUpperCase()} @ ${p.strike.toLocaleString()} → ` +
          `${p.status.toUpperCase()} (settle ${price.toLocaleString()})  P&L $${(p.realizedPnlUsd ?? 0).toFixed(2)}`,
      );
      if (p.surface === "testnet") await redeemOnChain(p);
    }
  }
  console.log(
    `\nSettled ${[...byOracle.keys()].length} oracle(s). Realized P&L this run: $${totalPnl.toFixed(2)}. ` +
      `Lifetime: $${portfolio.realizedPnlUsd().toFixed(2)}.`,
  );
}

main().catch((err) => {
  console.error("settle failed:", err);
  process.exit(1);
});
