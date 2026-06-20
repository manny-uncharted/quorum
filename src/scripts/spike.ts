/**
 * Full write-path spike: create manager → deposit DUSDC → preview → mint a binary
 * position on testnet, then read the resulting position back.
 *
 *   bun run spike                  # mint ~1.0 DUSDC notional, ATM UP
 *   bun run spike <qtyRaw> <ticksOTM> <up|down>
 *
 * Requires SUI_PRIVATE_KEY in .env, with testnet SUI (gas) + DUSDC.
 * Set PREDICT_MANAGER_ID in .env after the first run to reuse the manager.
 */

import { Transaction } from "@mysten/sui/transactions";

import { client, loadKeypair } from "../chain/client.js";
import { fetchTradableMarkets } from "../predict/server.js";
import { fetchOraclePrices, strikeNearForward } from "../predict/oracle.js";
import {
  addDeposit,
  addMint,
  buildCreateManager,
  fromDusdcRaw,
  previewTrade,
  toDusdcRaw,
  type Direction,
  type TradeIntent,
} from "../predict/market.js";

/** Find (or create + share) a PredictManager, returning its object id. */
async function ensureManager(owner: string): Promise<string> {
  const existing = process.env.PREDICT_MANAGER_ID?.trim();
  if (existing) {
    console.log(`Using PREDICT_MANAGER_ID ${existing}`);
    return existing;
  }
  console.log("Creating a PredictManager…");
  const tx = buildCreateManager();
  const res = await client.signAndExecuteTransaction({
    signer: loadKeypair(),
    transaction: tx,
    options: { showObjectChanges: true, showEffects: true },
  });
  await client.waitForTransaction({ digest: res.digest });
  const created = res.objectChanges?.find(
    (c) => c.type === "created" && c.objectType.includes("PredictManager"),
  );
  if (!created || created.type !== "created") {
    throw new Error("Could not locate created PredictManager in objectChanges");
  }
  console.log(`  manager ${created.objectId} (digest ${res.digest})`);
  console.log(`  → add PREDICT_MANAGER_ID=${created.objectId} to .env to reuse`);
  return created.objectId;
}

async function main(): Promise<void> {
  const kp = loadKeypair();
  const owner = kp.getPublicKey().toSuiAddress();
  console.log(`Signer ${owner}\n`);

  const quantity = BigInt(process.argv[2] ?? "1000000");
  const ticksOtm = Number(process.argv[3] ?? "0");
  const direction = (process.argv[4] as Direction) ?? "up";

  const markets = await fetchTradableMarkets();
  const market = markets.find((m) => m.msToExpiry > 30 * 60_000) ?? markets[0];
  if (!market) throw new Error("No tradable markets right now — re-run shortly.");

  const prices = await fetchOraclePrices(market.oracleId);
  const strikeRaw = strikeNearForward(
    prices.forwardRaw,
    BigInt(market.raw.tick_size),
    ticksOtm,
  );
  const intent: TradeIntent = { market, direction, strikeRaw, quantity };

  console.log(
    `${market.asset} ${direction.toUpperCase()} @ ${(Number(strikeRaw) / 1e9).toLocaleString()} ` +
      `(forward ${prices.forward.toLocaleString()}), expiry ${market.expiry.toISOString()}`,
  );

  const { costRaw } = await previewTrade(intent, owner);
  // Fund the manager with a small buffer over the quoted cost.
  const depositRaw = costRaw + toDusdcRaw(0.5);
  console.log(
    `Quoted cost ≈ ${fromDusdcRaw(costRaw)} DUSDC; depositing ${fromDusdcRaw(depositRaw)} DUSDC\n`,
  );

  const managerId = await ensureManager(owner);

  const tx = new Transaction();
  await addDeposit(tx, managerId, owner, depositRaw);
  addMint(tx, managerId, intent);

  const res = await client.signAndExecuteTransaction({
    signer: kp,
    transaction: tx,
    options: { showEffects: true, showBalanceChanges: true },
  });
  await client.waitForTransaction({ digest: res.digest });

  const status = res.effects?.status?.status;
  console.log(`mint tx ${res.digest} → ${status}`);
  if (status !== "success") {
    console.error("effects:", JSON.stringify(res.effects, null, 2));
    process.exit(1);
  }
  for (const b of res.balanceChanges ?? []) {
    console.log(`  balance ${b.coinType.split("::").at(-1)}: ${b.amount}`);
  }
  console.log("\n✅ Minted a binary position on DeepBook Predict (testnet).");
  console.log(
    `   Explorer: https://suiscan.xyz/testnet/tx/${res.digest}`,
  );
}

main().catch((err) => {
  console.error("spike failed:", err);
  process.exit(1);
});
