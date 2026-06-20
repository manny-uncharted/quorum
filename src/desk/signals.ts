/**
 * Signal source — the pluggable "brain" that turns a market into a probability.
 *
 * Two implementations share this contract so the rest of the desk (orchestrator,
 * planner, risk gate, executor) is identical regardless of how the estimate was
 * formed:
 *   - HeuristicSignalSource (keyless, deterministic) — beginners / paper trading.
 *   - GeminiSignalSource (multi-agent LLM debate) — analysts / experienced traders.
 */

import type { AnalystSignal, BinaryProposal } from "./schemas.js";
import type { AnalystKind } from "./events.js";
import type { MarketContext } from "./types.js";

export interface AnalystOutput {
  analyst: AnalystKind;
  signal: AnalystSignal;
}

/** The complete reasoning artifact for one market. */
export interface DeskAnalysis {
  analystSignals: AnalystOutput[];
  /** Optional bull/bear debate transcript (LLM source populates it). */
  debate?: { bull: string; bear: string };
  proposal: BinaryProposal;
}

/**
 * Streaming hooks so a source can surface partial results (each analyst signal,
 * each debate turn) the instant they're ready — critical for slow LLM sources so
 * the UI/CLI sees progress live instead of one batch at the end.
 */
export interface AnalyzeHooks {
  onAnalyst?: (a: AnalystOutput) => void;
  onDebate?: (speaker: "bull" | "bear", content: string) => void;
}

export interface SignalSource {
  /** Stable id surfaced on events/audit, e.g. "heuristic" | "gemini". */
  readonly id: string;
  analyze(context: MarketContext, hooks?: AnalyzeHooks): Promise<DeskAnalysis>;
}

/**
 * Blend per-analyst signals into one subjective P(up), anchored on the market
 * baseline. Shared by both sources so the aggregation rule is identical and
 * auditable: each analyst nudges probability by `lean · strength · confidence`,
 * weighted, and the total deviation from baseline is capped (calibration first).
 */
export function blendToProbability(
  baselineProbUp: number,
  signals: AnalystOutput[],
  opts: { maxDeviation?: number; weights?: Partial<Record<AnalystKind, number>> } = {},
): { probUp: number; confidence: number } {
  const maxDeviation = opts.maxDeviation ?? 0.15;
  const weights: Record<AnalystKind, number> = {
    volatility: opts.weights?.volatility ?? 0.5,
    momentum: opts.weights?.momentum ?? 1.0,
    catalyst: opts.weights?.catalyst ?? 0.8,
    flow: opts.weights?.flow ?? 0.8,
  };

  let weightedDev = 0;
  let confAccum = 0;
  let wsum = 0;
  for (const { analyst, signal } of signals) {
    const w = weights[analyst];
    const dir = signal.lean === "up" ? 1 : signal.lean === "down" ? -1 : 0;
    // Each analyst's vote in probability points: up to ~maxDeviation at full conviction.
    weightedDev += w * dir * signal.strength * signal.confidence * maxDeviation;
    confAccum += w * signal.confidence;
    wsum += w;
  }
  const dev = Math.max(-maxDeviation, Math.min(maxDeviation, weightedDev / (wsum || 1)));
  const probUp = Math.max(0.01, Math.min(0.99, baselineProbUp + dev));
  const confidence = wsum > 0 ? Math.min(1, confAccum / wsum) : 0;
  return { probUp, confidence };
}
