/**
 * Market feed — reads live oracle/market state from the predict-server.
 *
 * This is the only off-chain dependency in the read path. It is deliberately thin:
 * fetch, validate shape, normalize. Everything downstream (agents, UI, executor)
 * consumes `MarketView`.
 */

import { PREDICT_SERVER_URL } from "../chain/constants.js";
import {
  type MarketView,
  type OracleRecord,
  toMarketView,
} from "./types.js";

async function getJson<T>(path: string): Promise<T> {
  const url = `${PREDICT_SERVER_URL}${path}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`predict-server ${path} -> ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

/** All oracles the server knows about, normalized. */
export async function fetchMarkets(): Promise<MarketView[]> {
  const records = await getJson<OracleRecord[]>("/oracles");
  const now = Date.now();
  return records.map((r) => toMarketView(r, now));
}

/** Active, not-yet-expired markets, soonest expiry first. */
export async function fetchTradableMarkets(): Promise<MarketView[]> {
  const all = await fetchMarkets();
  return all
    .filter((m) => m.status === "active" && m.msToExpiry > 0)
    .sort((a, b) => a.msToExpiry - b.msToExpiry);
}

/** Look up a single market by oracle id. */
export async function findMarket(
  oracleId: string,
): Promise<MarketView | undefined> {
  const all = await fetchMarkets();
  return all.find((m) => m.oracleId === oracleId);
}
