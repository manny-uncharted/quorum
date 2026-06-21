/**
 * Risk gate — code-owned circuit breakers.
 *
 * Risk is arithmetic and policy, not vibes, so it lives here (not in a prompt).
 * The LLM may *annotate* risk, but this deterministic gate is the hard authority
 * over whether a sized plan executes, mirroring DeepBook market-maker circuit
 * breakers but adapted to directional binary positions.
 */

import { sviTotalVariance } from "./quant.js";
import type { RiskVerdict } from "./schemas.js";
import type { BinaryTradePlan, MarketContext } from "./types.js";

export interface RiskLimits {
  /** Reject if fewer than this many minutes to expiry (settlement risk). */
  minMinsToExpiry: number;
  /** Reject if more than this many minutes to expiry (stale thesis). */
  maxMinsToExpiry: number;
  /** Hard cap on bankroll fraction per trade. */
  maxStakeFraction: number;
  /** Halt if annualized implied vol exceeds this (regime breaker). */
  maxAnnualizedVol: number;
  /** Minimum edge (probability points) after costs. */
  minEdge: number;
  /** Slippage tolerance in basis points. */
  slippageToleranceBps: number;
}

export const DEFAULT_RISK_LIMITS: RiskLimits = {
  minMinsToExpiry: 5,
  maxMinsToExpiry: 24 * 60,
  maxStakeFraction: 0.05,
  maxAnnualizedVol: 2.5, // 250% — testnet BTC vol can be high; tune for prod
  minEdge: 0.03,
  slippageToleranceBps: 50, // 0.5%
};

/** Annualized implied vol from the ATM total variance and time to expiry. */
export function annualizedImpliedVol(context: MarketContext): number {
  const tYears = Math.max(context.minsToExpiry, 1) / (60 * 24 * 365);
  const w0 = sviTotalVariance(context.svi, 0);
  return Math.sqrt(w0 / tYears);
}

/**
 * Evaluate a sized plan against the limits. Returns a RiskVerdict listing each
 * breaker and its status. `resize` is returned when only the stake is too big;
 * `veto` for any hard violation.
 */
export function applyRiskGate(
  plan: BinaryTradePlan,
  context: MarketContext,
  limits: RiskLimits = DEFAULT_RISK_LIMITS,
): RiskVerdict {
  const breakers: string[] = [];
  const vetoes: string[] = [];

  const mins = context.minsToExpiry;
  if (mins < limits.minMinsToExpiry) vetoes.push(`time-to-expiry ${mins}m < ${limits.minMinsToExpiry}m`);
  else if (mins > limits.maxMinsToExpiry) vetoes.push(`time-to-expiry ${mins}m > ${limits.maxMinsToExpiry}m`);
  else breakers.push(`time-to-expiry OK (${mins}m)`);

  const vol = annualizedImpliedVol(context);
  if (vol > limits.maxAnnualizedVol) vetoes.push(`vol spike ${(vol * 100).toFixed(0)}% > ${(limits.maxAnnualizedVol * 100).toFixed(0)}%`);
  else breakers.push(`vol regime OK (${(vol * 100).toFixed(0)}% annualized)`);

  if (plan.edge < limits.minEdge) vetoes.push(`edge ${(plan.edge * 100).toFixed(1)}% < ${(limits.minEdge * 100).toFixed(1)}%`);
  else breakers.push(`edge OK (${(plan.edge * 100).toFixed(1)}%)`);

  if (vetoes.length > 0) {
    return {
      decision: "veto",
      maxStakeFraction: 0,
      circuitBreakers: [...breakers, ...vetoes.map((v) => `VETO: ${v}`)],
      reasoning: `Blocked by ${vetoes.length} circuit breaker(s): ${vetoes.join("; ")}.`,
    };
  }

  if (plan.stakeFraction > limits.maxStakeFraction) {
    return {
      decision: "resize",
      maxStakeFraction: limits.maxStakeFraction,
      circuitBreakers: [...breakers, `stake ${(plan.stakeFraction * 100).toFixed(1)}% capped to ${(limits.maxStakeFraction * 100).toFixed(1)}%`],
      reasoning: `Stake exceeds per-trade cap; resizing to ${(limits.maxStakeFraction * 100).toFixed(1)}% of bankroll.`,
    };
  }

  return {
    decision: "approve",
    maxStakeFraction: limits.maxStakeFraction,
    circuitBreakers: breakers,
    reasoning: "All circuit breakers passed; plan approved as sized.",
  };
}
