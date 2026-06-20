/**
 * Keyless signal sources — no API key, fully deterministic.
 *
 *  - HeuristicSignalSource: derives modest analyst leans from on-chain features
 *    (surface spread, spot-vs-forward, SVI skew). Honest by design: with no
 *    price-history or news feed it usually finds no edge and the desk abstains —
 *    which is the correct behaviour most of the time. It exists so a beginner can
 *    run the full loop in paper mode with zero setup.
 *
 *  - ManualSignalSource: takes the operator's OWN probability estimate. This is
 *    the analyst persona's entry point — bring your view, let the desk handle
 *    edge, sizing, risk, and on-chain execution.
 */

import type { AnalystSignal, BinaryProposal } from "./schemas.js";
import { fetchMarketData, summarizeMarketData } from "./marketdata.js";
import {
  blendToProbability,
  type AnalyzeHooks,
  type AnalystOutput,
  type DeskAnalysis,
  type SignalSource,
} from "./signals.js";
import type { MarketContext } from "./types.js";

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

function sig(
  lean: AnalystSignal["lean"],
  strength: number,
  confidence: number,
  summary: string,
): AnalystSignal {
  return { lean, strength, confidence, summary };
}

export class HeuristicSignalSource implements SignalSource {
  readonly id = "heuristic";

  async analyze(ctx: MarketContext, hooks?: AnalyzeHooks): Promise<DeskAnalysis> {
    const md = await fetchMarketData(ctx.market.asset);

    // Volatility/pricing: non-directional; report the cost dislocation.
    const spread = ctx.marketProbUp - ctx.riskNeutralProbUp;
    const volSignal = sig(
      "neutral",
      Math.min(1, Math.abs(spread) * 20),
      0.8,
      `Market-implied P(up) ${(ctx.marketProbUp * 100).toFixed(1)}% vs risk-neutral ${(ctx.riskNeutralProbUp * 100).toFixed(1)}% (spread ${(spread * 100).toFixed(2)}pp). ${summarizeMarketData(md)}`,
    );

    // Momentum: real short-horizon returns + RSI from live candles.
    const ret = md.ret15mPct ?? (ctx.spot - ctx.forward) / ctx.forward * 100;
    const momLean = ret > 0.02 ? "up" : ret < -0.02 ? "down" : "neutral";
    const rsiTilt = md.rsi14 == null ? 0 : (md.rsi14 - 50) / 50; // -1..1
    const momSignal = sig(
      momLean,
      clamp01(Math.abs(ret) / 0.3 * 0.6 + Math.abs(rsiTilt) * 0.4),
      md.ret15mPct == null ? 0.3 : 0.6,
      `15m ${ret.toFixed(3)}% · 1h ${(md.ret1hPct ?? 0).toFixed(3)}% · RSI14 ${md.rsi14?.toFixed(0) ?? "n/a"}.`,
    );

    // Catalyst/sentiment: crowd Fear & Greed (contrarian at extremes).
    const fg = md.fearGreed;
    const catLean = fg == null ? "neutral" : fg <= 25 ? "up" : fg >= 75 ? "down" : "neutral";
    const catSignal = sig(
      catLean,
      fg == null ? 0 : Math.min(1, Math.abs(fg - 50) / 50),
      fg == null ? 0.2 : 0.4,
      fg == null ? "No sentiment feed." : `Fear & Greed ${fg} (${md.fearGreedLabel}) — extremes are mean-reverting.`,
    );

    // Flow: perp funding when available, else SVI skew (rho) as a proxy.
    const funding = md.fundingRatePct;
    const flowLean =
      funding != null
        ? funding > 0.01 ? "down" : funding < -0.01 ? "up" : "neutral" // crowded longs fade
        : ctx.svi.rho < -0.2 ? "down" : ctx.svi.rho > 0.2 ? "up" : "neutral";
    const flowSignal = sig(
      flowLean,
      funding != null ? Math.min(1, Math.abs(funding) / 0.05) : Math.min(1, Math.abs(ctx.svi.rho)),
      0.3,
      funding != null
        ? `Funding ${funding.toFixed(3)}% (${funding > 0 ? "longs pay" : "shorts pay"}).`
        : `No funding feed; SVI skew rho=${ctx.svi.rho.toFixed(3)}.`,
    );

    const analystSignals: AnalystOutput[] = [
      { analyst: "volatility", signal: volSignal },
      { analyst: "momentum", signal: momSignal },
      { analyst: "catalyst", signal: catSignal },
      { analyst: "flow", signal: flowSignal },
    ];
    for (const a of analystSignals) hooks?.onAnalyst?.(a);

    const { probUp, confidence } = blendToProbability(ctx.marketProbUp, analystSignals);
    const proposal: BinaryProposal = {
      subjectiveProbUp: probUp,
      confidence,
      abstain: false,
      keyDrivers: ["live momentum/RSI", "Fear & Greed", "funding/skew"],
      reasoning: `Deterministic heuristic anchored on the market baseline; leans from live momentum, sentiment, and positioning. Subjective P(up) ${(probUp * 100).toFixed(1)}%.`,
    };
    return { analystSignals, proposal };
  }
}

/** Operator-supplied probability — the analyst's own view drives the desk. */
export class ManualSignalSource implements SignalSource {
  readonly id = "manual";
  constructor(
    private readonly probUp: number,
    private readonly confidence = 0.7,
    private readonly note = "Manual analyst override.",
  ) {}

  async analyze(_ctx: MarketContext): Promise<DeskAnalysis> {
    const proposal: BinaryProposal = {
      subjectiveProbUp: Math.max(0.01, Math.min(0.99, this.probUp)),
      confidence: this.confidence,
      abstain: false,
      keyDrivers: ["operator estimate"],
      reasoning: this.note,
    };
    return { analystSignals: [], proposal };
  }
}
