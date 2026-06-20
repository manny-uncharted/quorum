import { test, expect } from "bun:test";

import {
  decide,
  impliedProb,
  kellyFraction,
  normCdf,
  riskNeutralProbAbove,
  sviTotalVariance,
  type Svi,
} from "./quant.js";

// Real SVI surface read off oracle 0xbc1daf16… (raw values / 1e9).
const SVI: Svi = {
  a: 16680 / 1e9,
  b: 168634 / 1e9,
  rho: -295664135 / 1e9,
  m: -1956673 / 1e9,
  sigma: 1000000 / 1e9,
};
const FORWARD = 64930.952;

test("normCdf hits known points", () => {
  expect(normCdf(0)).toBeCloseTo(0.5, 6);
  expect(normCdf(1.96)).toBeCloseTo(0.975, 3);
  expect(normCdf(-1.96)).toBeCloseTo(0.025, 3);
});

test("SVI total variance is positive and lowest near m", () => {
  const wAtm = sviTotalVariance(SVI, 0);
  expect(wAtm).toBeGreaterThan(0);
  // Convex smile: variance rises as we move away from the minimum.
  expect(sviTotalVariance(SVI, 0.1)).toBeGreaterThan(wAtm);
  expect(sviTotalVariance(SVI, -0.1)).toBeGreaterThan(wAtm);
});

test("ATM risk-neutral prob is ~50% and monotonic in strike", () => {
  const atm = riskNeutralProbAbove(FORWARD, FORWARD, SVI);
  expect(atm).toBeGreaterThan(0.45);
  expect(atm).toBeLessThan(0.55);
  // Higher strike => lower prob of finishing above it.
  const hi = riskNeutralProbAbove(FORWARD, FORWARD * 1.02, SVI);
  const lo = riskNeutralProbAbove(FORWARD, FORWARD * 0.98, SVI);
  expect(hi).toBeLessThan(atm);
  expect(lo).toBeGreaterThan(atm);
});

test("impliedProb reproduces the observed testnet quote", () => {
  // get_trade_amounts -> (510722, _) for quantity 1_000_000 raw.
  expect(impliedProb(510722n, 1_000_000n)).toBeCloseTo(0.5107, 4);
});

test("kellyFraction is 0 without edge, fractional with edge", () => {
  expect(kellyFraction(0.5, 0.5)).toBe(0); // no edge
  expect(kellyFraction(0.4, 0.5)).toBe(0); // negative edge
  // p=0.6, c=0.5: full Kelly 0.2, quarter-Kelly 0.05.
  expect(kellyFraction(0.6, 0.5, 0.25)).toBeCloseTo(0.05, 6);
});

test("decide: trades the edge, sized and capped", () => {
  const d = decide({ subjectiveProbUp: 0.6, marketProbUp: 0.51 });
  expect(d.trade).toBe(true);
  expect(d.direction).toBe("up");
  expect(d.edge).toBeCloseTo(0.09, 6);
  expect(d.stakeFraction).toBeGreaterThan(0);
  expect(d.stakeFraction).toBeLessThanOrEqual(0.05); // bankroll cap
});

test("decide: abstains below edge threshold", () => {
  const d = decide({ subjectiveProbUp: 0.52, marketProbUp: 0.51 });
  expect(d.trade).toBe(false);
  expect(d.stakeFraction).toBe(0);
});

test("decide: takes DOWN when subjective < market", () => {
  const d = decide({ subjectiveProbUp: 0.4, marketProbUp: 0.51 });
  expect(d.trade).toBe(true);
  expect(d.direction).toBe("down");
  expect(d.edge).toBeCloseTo(0.11, 6);
});
