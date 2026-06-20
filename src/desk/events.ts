/**
 * Typed event stream for a desk run.
 *
 * Every stage emits an immutable, JSON-serializable event. This is the single
 * source the CLI, the audit/evidence bundle, and (Day 3) the SSE-driven UI all
 * consume — so the reasoning is fully reconstructable from the event log alone.
 */

import type { ExecutionEnvelope } from "../fabric/types/index.js";
import type { AnalystSignal, BinaryProposal, RiskVerdict } from "./schemas.js";
import type { BinaryTradePlan, MarketContext } from "./types.js";

export type AnalystKind = "volatility" | "momentum" | "catalyst" | "flow";

export type DeskEvent =
  | { type: "market_context"; ts: string; context: MarketContext }
  | { type: "analyst_signal"; ts: string; analyst: AnalystKind; signal: AnalystSignal }
  | { type: "debate_turn"; ts: string; speaker: "bull" | "bear"; content: string }
  | { type: "proposal"; ts: string; proposal: BinaryProposal }
  | { type: "plan"; ts: string; plan: BinaryTradePlan }
  | { type: "risk_verdict"; ts: string; verdict: RiskVerdict }
  | { type: "execution"; ts: string; envelope: ExecutionEnvelope }
  | { type: "portfolio_block"; ts: string; reason: string }
  | { type: "abstain"; ts: string; stage: string; reason: string };

export type DeskEventListener = (e: DeskEvent) => void;

/** Distributes `Omit` across each union member so the discriminant is preserved. */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** An event minus the timestamp, which the log stamps on emit. */
export type DeskEventInput = DistributiveOmit<DeskEvent, "ts">;

/** Tiny collector: records every event and forwards to an optional listener. */
export class DeskEventLog {
  readonly events: DeskEvent[] = [];
  constructor(private readonly onEvent?: DeskEventListener) {}

  emit(input: DeskEventInput): void {
    const e = { ...input, ts: new Date().toISOString() } as DeskEvent;
    this.events.push(e);
    this.onEvent?.(e);
  }
}
