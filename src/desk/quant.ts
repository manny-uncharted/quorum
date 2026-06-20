/**
 * Binary-option quant core — first principles.
 *
 * A DeepBook Predict binary pays 1 unit if the underlying finishes on the chosen
 * side of `strike` at `expiry`, else 0. Pricing is therefore a *probability*: the
 * cost per unit payout is the market's implied probability of that outcome.
 *
 * Two probabilities matter, and the whole desk hinges on their difference:
 *
 *   1. RISK-NEUTRAL prob — N(d2) derived from the oracle's SVI volatility surface.
 *      This is what the contract itself prices off, so it (≈) equals the market
 *      quote. Re-deriving it yields NO edge — it is the fair, driftless baseline.
 *
 *   2. SUBJECTIVE prob — the desk's estimate of the *real-world* probability,
 *      formed from directional signals (momentum, flow, catalysts) that the
 *      driftless risk-neutral measure ignores. THIS is where edge lives.
 *
 *   edge = P_subjective(up) − P_implied(market)
 *
 * We trade when |edge| clears a threshold, take the side of the edge, and size
 * with fractional Kelly. Everything here is pure and unit-tested; no network,
 * no keys, no funds.
 */

/** SVI parameters (scaled to real units) for one oracle/expiry. */
export interface Svi {
  a: number;
  b: number;
  rho: number;
  m: number;
  sigma: number;
}

/** Standard normal CDF (Abramowitz & Stegun 7.1.26, ~1e-7 accuracy). */
export function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-(x * x) / 2);
  const p =
    d *
    t *
    (0.31938153 +
      t *
        (-0.356563782 +
          t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

/**
 * SVI total implied variance at log-moneyness `k = ln(K/F)`:
 *   w(k) = a + b · ( rho·(k − m) + sqrt((k − m)² + sigma²) )
 * `w` is total variance to expiry (i.e. σ²·T), so σ√T = sqrt(w).
 */
export function sviTotalVariance(svi: Svi, k: number): number {
  const km = k - svi.m;
  const w = svi.a + svi.b * (svi.rho * km + Math.sqrt(km * km + svi.sigma * svi.sigma));
  return Math.max(w, 1e-12); // guard: variance is strictly positive
}

/**
 * Risk-neutral probability the underlying finishes ABOVE `strike` at expiry,
 * given the forward and the SVI surface. P(S_T > K) = N(d2),
 *   d2 = (ln(F/K) − ½w) / sqrt(w),  with σ√T = sqrt(w).
 */
export function riskNeutralProbAbove(
  forward: number,
  strike: number,
  svi: Svi,
): number {
  if (forward <= 0 || strike <= 0) throw new Error("forward/strike must be > 0");
  const k = Math.log(strike / forward); // log-moneyness, relative to forward
  const w = sviTotalVariance(svi, k);
  const sqrtW = Math.sqrt(w);
  const d2 = (Math.log(forward / strike) - 0.5 * w) / sqrtW;
  return normCdf(d2);
}

/**
 * Market-implied probability of the minted side, from a `get_trade_amounts`
 * quote: cost per unit payout. `payoutPerUnit` defaults to the position
 * quantity (a winning binary returns ~1 quote unit per contract).
 */
export function impliedProb(costRaw: bigint, quantityRaw: bigint): number {
  if (quantityRaw <= 0n) throw new Error("quantity must be > 0");
  return Number(costRaw) / Number(quantityRaw);
}

/**
 * Fractional-Kelly stake as a fraction of bankroll for a binary bought at cost
 * `c` (per unit payout) when you believe the win probability is `p`.
 *   full Kelly f* = (p − c) / (1 − c)
 * Returns 0 when there is no edge (p ≤ c). `fraction` applies a safety haircut
 * (default ¼-Kelly — standard practice to cut variance and estimation error).
 */
export function kellyFraction(p: number, c: number, fraction = 0.25): number {
  if (c <= 0 || c >= 1) return 0;
  const full = (p - c) / (1 - c);
  if (!Number.isFinite(full) || full <= 0) return 0;
  return Math.min(1, full * fraction);
}

export type Direction = "up" | "down";

export interface DecisionInput {
  /** Desk's real-world probability the underlying finishes UP (above strike). */
  subjectiveProbUp: number;
  /** Market-implied probability of UP (cost of the UP binary per unit). */
  marketProbUp: number;
  /** Minimum |edge| (probability points) required to trade. Default 3%. */
  edgeThreshold?: number;
  /** Kelly safety fraction. Default ¼. */
  kellyFractionCap?: number;
  /** Hard cap on bankroll fraction per trade, applied after Kelly. Default 5%. */
  maxBankrollFraction?: number;
}

export interface Decision {
  /** Whether the desk should take a position at all. */
  trade: boolean;
  direction: Direction;
  /** P_subjective − P_market for the chosen side (always ≥ 0 when trading). */
  edge: number;
  /** Cost per unit payout of the chosen side. */
  cost: number;
  /** Bankroll fraction to stake (0 when not trading). */
  stakeFraction: number;
  reason: string;
}

/**
 * Turn a subjective vs market probability into a sized, directional decision.
 * UP and DOWN are complementary binaries: P_market(down) = 1 − P_market(up),
 * P_subjective(down) = 1 − P_subjective(up). We pick the side with positive edge
 * and size it by fractional Kelly, then clamp to the per-trade bankroll cap.
 */
export function decide(input: DecisionInput): Decision {
  const {
    subjectiveProbUp,
    marketProbUp,
    edgeThreshold = 0.03,
    kellyFractionCap = 0.25,
    maxBankrollFraction = 0.05,
  } = input;

  const upEdge = subjectiveProbUp - marketProbUp;
  const downEdge = -upEdge; // 1−p_s − (1−p_m) = p_m − p_s
  const direction: Direction = upEdge >= 0 ? "up" : "down";
  const edge = Math.abs(upEdge);

  const p = direction === "up" ? subjectiveProbUp : 1 - subjectiveProbUp;
  const cost = direction === "up" ? marketProbUp : 1 - marketProbUp;

  if (edge < edgeThreshold) {
    return {
      trade: false,
      direction,
      edge,
      cost,
      stakeFraction: 0,
      reason: `edge ${(edge * 100).toFixed(1)}% below threshold ${(edgeThreshold * 100).toFixed(1)}%`,
    };
  }

  const kelly = kellyFraction(p, cost, kellyFractionCap);
  const stakeFraction = Math.min(kelly, maxBankrollFraction);
  if (stakeFraction <= 0) {
    return {
      trade: false,
      direction,
      edge,
      cost,
      stakeFraction: 0,
      reason: `no positive Kelly stake (p=${p.toFixed(3)}, cost=${cost.toFixed(3)})`,
    };
  }
  return {
    trade: true,
    direction,
    edge,
    cost,
    stakeFraction,
    reason:
      `${direction.toUpperCase()} edge ${(edge * 100).toFixed(1)}% ` +
      `(subjective ${(p * 100).toFixed(1)}% vs market ${(cost * 100).toFixed(1)}%), ` +
      `stake ${(stakeFraction * 100).toFixed(1)}% of bankroll`,
  };
}
