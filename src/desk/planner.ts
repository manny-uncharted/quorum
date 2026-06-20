/**
 * Planner — turns a live market + the desk's subjective probability into a
 * sized, executable plan. Sits between the agent debate (which produces a
 * subjective P(up)) and the executor (which fills it).
 */

import { randomUUID } from "node:crypto";

import { fetchOracleSurface, snapToTick } from "../predict/oracle.js";
import { previewTrade, toDusdcRaw } from "../predict/market.js";
import type { MarketView } from "../predict/types.js";
import {
  decide,
  impliedProb,
  riskNeutralProbAbove,
  type DecisionInput,
} from "./quant.js";
import type { BinaryTradePlan, MarketContext } from "./types.js";

/** Reference quantity used to read a per-unit market-implied probability. */
const REF_QTY = 1_000_000n;

/**
 * Assemble the full decision context for a market: live surface, chosen strike
 * (defaults to at-the-money), risk-neutral baseline, and the market-implied
 * probability from a real `get_trade_amounts` quote.
 */
export async function buildMarketContext(
  market: MarketView,
  opts: { strikeRaw?: bigint; quoteSender: string } & object,
): Promise<MarketContext> {
  const surface = await fetchOracleSurface(market.oracleId);
  const tickRaw = BigInt(market.raw.tick_size);
  const strikeRaw = opts.strikeRaw ?? snapToTick(surface.forwardRaw, tickRaw);
  const strike = Number(strikeRaw) / 1e9;

  const riskNeutralProbUp = riskNeutralProbAbove(
    surface.forward,
    strike,
    surface.svi,
  );

  const { costRaw } = await previewTrade(
    { market, direction: "up", strikeRaw, quantity: REF_QTY },
    opts.quoteSender,
  );
  const marketProbUp = impliedProb(costRaw, REF_QTY);

  return {
    market,
    forward: surface.forward,
    spot: surface.spot,
    svi: surface.svi,
    strikeRaw,
    strike,
    riskNeutralProbUp,
    marketProbUp,
    minsToExpiry: Math.round(market.msToExpiry / 60_000),
  };
}

export interface PlanOptions extends Omit<DecisionInput, "subjectiveProbUp" | "marketProbUp"> {
  /** Bankroll in USD (DUSDC) the desk is allowed to deploy. */
  bankrollUsd: number;
  /** Don't enter within this many minutes of expiry (settlement risk). */
  minMinsToExpiry?: number;
}

/**
 * Apply the quant decision and convert the Kelly stake into a position
 * quantity. Returns null when the desk abstains (no edge, too close to expiry,
 * or zero size).
 */
export function planTrade(
  context: MarketContext,
  subjectiveProbUp: number,
  thesis: string,
  opts: PlanOptions,
): BinaryTradePlan | null {
  const { bankrollUsd, minMinsToExpiry = 5, ...decisionOpts } = opts;

  if (context.minsToExpiry < minMinsToExpiry) return null;

  const decision = decide({
    subjectiveProbUp,
    marketProbUp: context.marketProbUp,
    ...decisionOpts,
  });
  if (!decision.trade) return null;

  // stake$ → quantity, using the per-unit cost implied by the reference quote.
  const costPerUnit = decision.cost; // DUSDC per 1 unit payout
  if (costPerUnit <= 0) return null;
  const stakeUsd = bankrollUsd * decision.stakeFraction;
  const quantity = toDusdcRaw(stakeUsd / costPerUnit); // payout units ≈ raw qty
  if (quantity <= 0n) return null;

  return {
    decisionId: randomUUID(),
    context,
    direction: decision.direction,
    quantity,
    subjectiveProbUp,
    edge: decision.edge,
    stakeFraction: decision.stakeFraction,
    thesis: `${thesis} — ${decision.reason}`,
  };
}
