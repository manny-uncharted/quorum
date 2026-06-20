/**
 * Prediction-desk domain model.
 *
 * Deliberately binary-option native — NOT the equity Buy/Hold/Sell shape from
 * the vendored fabric. A position is a directional bet on an oracle/strike/expiry
 * tuple; the desk reasons in probabilities and edge, not price targets.
 */

import type { MarketView } from "../predict/types.js";
import type { Direction, Svi } from "./quant.js";

/**
 * Everything the agents and quant need about one tradable market at decision
 * time: the market, its live surface, and the derived baseline probabilities.
 */
export interface MarketContext {
  market: MarketView;
  /** Forward price (human units). */
  forward: number;
  spot: number;
  svi: Svi;
  /** Strike under consideration, raw on-chain units (on the tick grid). */
  strikeRaw: bigint;
  /** Strike in human units. */
  strike: number;
  /** Risk-neutral P(up) from the SVI surface — the fair, driftless baseline. */
  riskNeutralProbUp: number;
  /** Market-implied P(up) from a live `get_trade_amounts` quote. */
  marketProbUp: number;
  /** Minutes to expiry. */
  minsToExpiry: number;
}

/**
 * A fully-resolved, ready-to-execute order. Produced by the planner after the
 * agent debate + risk gate; consumed by the executor.
 */
export interface BinaryTradePlan {
  decisionId: string;
  context: MarketContext;
  direction: Direction;
  /** Position quantity in raw contract units. */
  quantity: bigint;
  /** The desk's real-world P(up) that drove the decision. */
  subjectiveProbUp: number;
  /** P_subjective − P_market for the chosen side (≥ 0). */
  edge: number;
  /** Bankroll fraction staked. */
  stakeFraction: number;
  /** Human-readable thesis for the audit/evidence bundle. */
  thesis: string;
}

/** Context passed to an executor for one order. */
export interface ExecContext {
  runId: string;
  traceId?: string;
}
