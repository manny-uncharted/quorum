/**
 * Structured outputs for the prediction-desk agents — rebuilt from first
 * principles for binary options, replacing the equity Buy/Hold/Sell schemas.
 *
 * Division of labour (deliberate): the LLM agents estimate a *probability* and
 * argue about it; the deterministic quant core (`quant.ts`) owns all arithmetic
 * — edge, Kelly, sizing, thresholds. Models are bad at arithmetic and good at
 * judgement, so we never let them compute a position size.
 */

import { z } from "zod";

/** A directional lean with calibrated strength/confidence from one analyst. */
export const AnalystSignal = z.object({
  lean: z
    .enum(["up", "down", "neutral"])
    .describe(
      "Direction this analysis favours for the underlying by expiry: 'up' " +
        "(finishes above strike), 'down' (below), or 'neutral' (no directional edge).",
    ),
  strength: z
    .number()
    .min(0)
    .max(1)
    .describe(
      "How strong the directional signal is, 0 (none) to 1 (very strong). " +
        "Be conservative: most short-horizon signals are weak.",
    ),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("Your confidence in this read given data quality, 0 to 1."),
  summary: z
    .string()
    .describe("2–4 sentence justification citing the specific evidence used."),
});
export type AnalystSignal = z.infer<typeof AnalystSignal>;

/**
 * The trader's synthesis. The single number that matters is `subjectiveProbUp`
 * — the desk's real-world probability the underlying finishes ABOVE the strike
 * at expiry. The quant core compares it to the market-implied probability to
 * find edge and size the trade.
 */
export const BinaryProposal = z.object({
  subjectiveProbUp: z
    .number()
    .min(0)
    .max(1)
    .describe(
      "Your best estimate of the REAL-WORLD probability the underlying finishes " +
        "above the strike at expiry (0–1). This is a drift-aware estimate: the " +
        "market-implied/risk-neutral baseline assumes zero drift, so only deviate " +
        "from it when directional signals (momentum, flow, catalysts) justify it.",
    ),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe(
      "Confidence in your probability estimate (0–1). Low confidence should keep " +
        "your estimate close to the market baseline.",
    ),
  abstain: z
    .boolean()
    .describe(
      "True if the desk should NOT trade this market regardless of edge — e.g. " +
        "an imminent high-impact catalyst, unreliable data, or degenerate pricing.",
    ),
  keyDrivers: z
    .array(z.string())
    .describe("The 2–5 factors that most moved your estimate off the baseline."),
  reasoning: z
    .string()
    .describe(
      "Concise thesis tying the analyst signals and debate to your probability. " +
        "State explicitly why real-world drift differs (or not) from risk-neutral.",
    ),
});
export type BinaryProposal = z.infer<typeof BinaryProposal>;

/** The risk officer's gate over a proposed, sized plan. */
export const RiskVerdict = z.object({
  decision: z
    .enum(["approve", "resize", "veto"])
    .describe(
      "approve: let the sized plan through. resize: approve but cap the stake. " +
        "veto: block the trade entirely.",
    ),
  maxStakeFraction: z
    .number()
    .min(0)
    .max(1)
    .nullable()
    .optional()
    .describe("When decision='resize', the hard cap on bankroll fraction."),
  circuitBreakers: z
    .array(z.string())
    .describe(
      "Named risk conditions you checked and their status, e.g. " +
        "'time-to-expiry OK', 'vol-spike none', 'catalyst within window: FOMC'.",
    ),
  reasoning: z.string().describe("Why this verdict, in 2–4 sentences."),
});
export type RiskVerdict = z.infer<typeof RiskVerdict>;
