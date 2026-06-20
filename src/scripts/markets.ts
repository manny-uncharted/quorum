/**
 * Read-only smoke test of the market feed. Needs no keys or funds.
 *
 *   bun run markets
 *
 * Proves the off-chain data path end to end: server reachable, shape valid,
 * normalization correct. This is the first green light of the Day-1 de-risk.
 */

import { fetchMarkets, fetchTradableMarkets } from "../predict/server.js";

function fmtDuration(ms: number): string {
  if (ms <= 0) return "expired";
  const m = Math.floor(ms / 60_000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m`;
}

async function main(): Promise<void> {
  const all = await fetchMarkets();
  const tradable = await fetchTradableMarkets();

  console.log(`Fetched ${all.length} oracles (${tradable.length} tradable).\n`);

  const byAsset = new Map<string, number>();
  for (const m of all) byAsset.set(m.asset, (byAsset.get(m.asset) ?? 0) + 1);
  console.log(
    "By asset: " +
      [...byAsset.entries()].map(([a, n]) => `${a}=${n}`).join("  "),
  );

  console.log("\nNext tradable markets:");
  for (const m of tradable.slice(0, 12)) {
    console.log(
      `  ${m.asset.padEnd(5)} strike≥${m.minStrike.toLocaleString().padStart(10)}` +
        `  tick ${m.tickSize}  expires in ${fmtDuration(m.msToExpiry).padEnd(8)}` +
        `  oracle ${m.oracleId.slice(0, 10)}…`,
    );
  }

  if (tradable.length === 0) {
    console.warn(
      "\n⚠️  No tradable markets right now (all expired/settled). " +
        "The server cycles markets; re-run shortly.",
    );
  }
}

main().catch((err) => {
  console.error("markets feed failed:", err);
  process.exit(1);
});
