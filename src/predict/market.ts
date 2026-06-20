/**
 * Transaction builders for DeepBook Predict.
 *
 * Everything here composes Programmable Transaction Block (PTB) fragments against
 * the verified testnet package. Pricing (`previewTrade`) runs through
 * `devInspect` — no gas, no signing, no funds — so we can prove the on-chain
 * pricing path before a wallet ever holds DUSDC.
 *
 * Move surface used (package `predict`):
 *   market_key::up|down|new(oracle_id, expiry, strike[, is_up]) -> MarketKey
 *   predict::get_trade_amounts(predict, oracle, key, qty, clock) -> (u64, u64)
 *   predict::mint<Quote>(predict, manager, oracle, key, qty, clock, ctx)
 *   predict::redeem<Quote>(predict, manager, oracle, key, qty, clock, ctx)
 *   predict::create_manager(ctx) -> ID   (shares a PredictManager)
 *   predict_manager::deposit<T>(manager, coin, ctx)
 */

import { Transaction, type TransactionResult } from "@mysten/sui/transactions";
import { bcs } from "@mysten/sui/bcs";

import { client } from "../chain/client.js";
import {
  CLOCK_OBJECT_ID,
  DUSDC,
  PREDICT,
  PREDICT_MODULE,
} from "../chain/constants.js";
import type { MarketView } from "./types.js";

const MARKET_KEY_MODULE = `${PREDICT.packageId}::market_key`;

/** YES (price ends above strike) vs NO (below). */
export type Direction = "up" | "down";

export interface TradeIntent {
  market: MarketView;
  direction: Direction;
  /** Strike in raw on-chain u64 units (must sit on the market's tick grid). */
  strikeRaw: bigint;
  /** Position quantity in raw contract units. */
  quantity: bigint;
}

/** Append a `market_key::{up,down}` call and return its result handle. */
export function buildMarketKey(tx: Transaction, intent: TradeIntent): TransactionResult {
  const expiry = BigInt(intent.market.raw.expiry);
  return tx.moveCall({
    target: `${MARKET_KEY_MODULE}::${intent.direction}`,
    arguments: [
      tx.pure.id(intent.market.oracleId),
      tx.pure.u64(expiry),
      tx.pure.u64(intent.strikeRaw),
    ],
  });
}

/**
 * Quote the cost/payout of a position without committing anything.
 * Returns the raw `(u64, u64)` pair from `get_trade_amounts` — the first is the
 * quote (DUSDC) cost to mint `quantity`, the second the settlement payout cap.
 * (Labels verified empirically in the preview script; isolated here so a
 * relabel is one edit.)
 */
export async function previewTrade(
  intent: TradeIntent,
  sender: string,
): Promise<{ costRaw: bigint; payoutRaw: bigint }> {
  const tx = new Transaction();
  const key = buildMarketKey(tx, intent);
  tx.moveCall({
    target: `${PREDICT_MODULE}::get_trade_amounts`,
    arguments: [
      tx.object(PREDICT.predictObjectId),
      tx.object(intent.market.oracleId),
      key,
      tx.pure.u64(intent.quantity),
      tx.object(CLOCK_OBJECT_ID),
    ],
  });

  const res = await client.devInspectTransactionBlock({
    sender,
    transactionBlock: tx,
  });

  if (res.error) {
    throw new Error(`get_trade_amounts devInspect error: ${res.error}`);
  }
  const ret = res.results?.at(-1)?.returnValues;
  if (!ret || ret.length < 2) {
    throw new Error(
      `Expected 2 return values from get_trade_amounts, got ${ret?.length ?? 0}`,
    );
  }
  const costRaw = bcs.u64().parse(Uint8Array.from(ret[0]![0]));
  const payoutRaw = bcs.u64().parse(Uint8Array.from(ret[1]![0]));
  return { costRaw: BigInt(costRaw), payoutRaw: BigInt(payoutRaw) };
}

/** Build (and share) a fresh PredictManager. Caller signs/executes. */
export function buildCreateManager(): Transaction {
  const tx = new Transaction();
  tx.moveCall({ target: `${PREDICT_MODULE}::create_manager`, arguments: [] });
  return tx;
}

/**
 * Append a `mint<DUSDC>` call. Quote is drawn from the manager's deposited
 * balance, so the manager must be funded first via {@link addDeposit}.
 */
export function addMint(
  tx: Transaction,
  managerId: string,
  intent: TradeIntent,
): void {
  const key = buildMarketKey(tx, intent);
  tx.moveCall({
    target: `${PREDICT_MODULE}::mint`,
    typeArguments: [DUSDC.type],
    arguments: [
      tx.object(PREDICT.predictObjectId),
      tx.object(managerId),
      tx.object(intent.market.oracleId),
      key,
      tx.pure.u64(intent.quantity),
      tx.object(CLOCK_OBJECT_ID),
    ],
  });
}

/** Append a `redeem<DUSDC>` call for a held position. */
export function addRedeem(
  tx: Transaction,
  managerId: string,
  intent: TradeIntent,
): void {
  const key = buildMarketKey(tx, intent);
  tx.moveCall({
    target: `${PREDICT_MODULE}::redeem`,
    typeArguments: [DUSDC.type],
    arguments: [
      tx.object(PREDICT.predictObjectId),
      tx.object(managerId),
      tx.object(intent.market.oracleId),
      key,
      tx.pure.u64(intent.quantity),
      tx.object(CLOCK_OBJECT_ID),
    ],
  });
}

/**
 * Append a deposit of `amountRaw` DUSDC into the manager. Splits a coin owned by
 * `owner`; merges fragments if no single coin is large enough.
 */
export async function addDeposit(
  tx: Transaction,
  managerId: string,
  owner: string,
  amountRaw: bigint,
): Promise<void> {
  const { data } = await client.getCoins({ owner, coinType: DUSDC.type });
  if (data.length === 0) {
    throw new Error(
      `No DUSDC in ${owner}. Request testnet DUSDC (currency ${DUSDC.currencyId}).`,
    );
  }
  const total = data.reduce((s, c) => s + BigInt(c.balance), 0n);
  if (total < amountRaw) {
    throw new Error(
      `Insufficient DUSDC: need ${amountRaw}, have ${total} (raw, 6 dp).`,
    );
  }
  const [primary, ...rest] = data;
  const primaryCoin = tx.object(primary!.coinObjectId);
  if (rest.length > 0) {
    tx.mergeCoins(
      primaryCoin,
      rest.map((c) => tx.object(c.coinObjectId)),
    );
  }
  const [deposit] = tx.splitCoins(primaryCoin, [tx.pure.u64(amountRaw)]);
  tx.moveCall({
    target: `${PREDICT.packageId}::predict_manager::deposit`,
    typeArguments: [DUSDC.type],
    arguments: [tx.object(managerId), deposit!],
  });
}

/** Scale a human DUSDC amount to raw u64 units. */
export function toDusdcRaw(human: number): bigint {
  return BigInt(Math.round(human * 10 ** DUSDC.decimals));
}

/** Scale raw DUSDC units back to a human number. */
export function fromDusdcRaw(raw: bigint): number {
  return Number(raw) / 10 ** DUSDC.decimals;
}
