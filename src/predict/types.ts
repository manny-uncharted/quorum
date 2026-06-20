/**
 * Domain types for DeepBook Predict markets.
 *
 * `OracleRecord` mirrors the raw shape returned by `GET /oracles` on the
 * predict-server. `MarketView` is the normalized, UI/agent-friendly projection.
 */

/** Raw record as served by the predict-server `/oracles` endpoint. */
export interface OracleRecord {
  predict_id: string;
  oracle_id: string;
  oracle_cap_id: string;
  underlying_asset: string;
  /** Expiry in epoch milliseconds. */
  expiry: number;
  /** Lowest strike, in on-chain fixed-point units (see STRIKE_SCALE). */
  min_strike: number;
  /** Strike increment, in on-chain fixed-point units. */
  tick_size: number;
  status: "active" | "settled" | string;
  activated_at: number | null;
  settlement_price: number | null;
  settled_at: number | null;
  created_checkpoint: number;
}

/**
 * On-chain strike/price fixed-point scale. Observed testnet values
 * (min_strike 5e13, tick 1e9 for BTC) imply prices are quoted in 1e9 units.
 * Verify against `oracle_config.move` before trusting in production; isolated
 * here so a correction is a one-line change.
 */
export const STRIKE_SCALE = 1e9;

/** Normalized market the agents and UI consume. */
export interface MarketView {
  oracleId: string;
  oracleCapId: string;
  predictId: string;
  asset: string;
  /** Expiry as a JS Date. */
  expiry: Date;
  /** Milliseconds until expiry (negative once expired). */
  msToExpiry: number;
  /** Human strike floor, scaled to real units. */
  minStrike: number;
  tickSize: number;
  status: OracleRecord["status"];
  settlementPrice: number | null;
  /** Untouched source record for transaction builders. */
  raw: OracleRecord;
}

export function toMarketView(r: OracleRecord, now = Date.now()): MarketView {
  return {
    oracleId: r.oracle_id,
    oracleCapId: r.oracle_cap_id,
    predictId: r.predict_id,
    asset: r.underlying_asset,
    expiry: new Date(r.expiry),
    msToExpiry: r.expiry - now,
    minStrike: r.min_strike / STRIKE_SCALE,
    tickSize: r.tick_size / STRIKE_SCALE,
    status: r.status,
    settlementPrice:
      r.settlement_price == null ? null : r.settlement_price / STRIKE_SCALE,
    raw: r,
  };
}
