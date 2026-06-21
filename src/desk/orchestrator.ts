/**
 * Desk orchestrator — the end-to-end loop.
 *
 *   signal source → proposal → planner (sizing) → risk gate → executor
 *
 * Emits a typed event for every stage (consumed by the CLI, audit bundle, and
 * the SSE UI). Signal-source-agnostic: heuristic, manual, or Gemini all
 * flow through the identical pipeline.
 */

import { randomUUID } from "node:crypto";

import type { ExecutionEnvelope } from "../fabric/types/index.js";
import { PredictExecutionProvider } from "./executor.js";
import { DeskEventLog, type DeskEvent, type DeskEventListener } from "./events.js";
import { planTrade } from "./planner.js";
import { applyRiskGate, DEFAULT_RISK_LIMITS, type RiskLimits } from "./risk.js";
import { DEFAULT_PORTFOLIO_LIMITS, type Portfolio, type PortfolioLimits } from "./portfolio.js";
import type { RiskVerdict } from "./schemas.js";
import type { SignalSource, DeskAnalysis } from "./signals.js";
import type { BinaryTradePlan, MarketContext } from "./types.js";

export interface DeskRunOptions {
  context: MarketContext;
  signalSource: SignalSource;
  executor: PredictExecutionProvider;
  bankrollUsd: number;
  limits?: RiskLimits;
  kellyFractionCap?: number;
  onEvent?: DeskEventListener;
  runId?: string;
  /** When provided, enforces portfolio-level circuit breakers + records fills. */
  portfolio?: Portfolio;
  portfolioLimits?: PortfolioLimits;
}

export interface DeskRunResult {
  runId: string;
  analysis: DeskAnalysis;
  plan: BinaryTradePlan | null;
  verdict: RiskVerdict | null;
  execution: ExecutionEnvelope | null;
  events: DeskEvent[];
}

export async function runDesk(opts: DeskRunOptions): Promise<DeskRunResult> {
  const {
    context,
    signalSource,
    executor,
    bankrollUsd,
    limits = DEFAULT_RISK_LIMITS,
    kellyFractionCap = 0.25,
    onEvent,
    runId = randomUUID(),
  } = opts;

  const log = new DeskEventLog(onEvent);
  const done = (
    analysis: DeskAnalysis,
    plan: BinaryTradePlan | null,
    verdict: RiskVerdict | null,
    execution: ExecutionEnvelope | null,
  ): DeskRunResult => ({ runId, analysis, plan, verdict, execution, events: log.events });

  log.emit({ type: "market_context", context });

  // Stream analyst signals + debate turns live, the instant each resolves.
  const analysis = await signalSource.analyze(context, {
    onAnalyst: (a) => log.emit({ type: "analyst_signal", analyst: a.analyst, signal: a.signal }),
    onDebate: (speaker, content) => log.emit({ type: "debate_turn", speaker, content }),
  });
  log.emit({ type: "proposal", proposal: analysis.proposal });

  if (analysis.proposal.abstain) {
    log.emit({ type: "abstain", stage: "proposal", reason: "agent flagged abstain" });
    return done(analysis, null, null, null);
  }

  const plan = planTrade(context, analysis.proposal.subjectiveProbUp, analysis.proposal.reasoning, {
    bankrollUsd,
    edgeThreshold: limits.minEdge,
    maxBankrollFraction: limits.maxStakeFraction,
    minMinsToExpiry: limits.minMinsToExpiry,
    kellyFractionCap,
  });
  if (!plan) {
    log.emit({ type: "abstain", stage: "planner", reason: "no qualifying edge / too close to expiry" });
    return done(analysis, null, null, null);
  }
  log.emit({ type: "plan", plan });

  const verdict = applyRiskGate(plan, context, limits);
  log.emit({ type: "risk_verdict", verdict });
  if (verdict.decision === "veto") {
    log.emit({ type: "abstain", stage: "risk", reason: verdict.reasoning });
    return done(analysis, plan, verdict, null);
  }

  // Apply a resize cap if the risk officer trimmed the stake.
  let finalPlan = plan;
  if (
    verdict.decision === "resize" &&
    verdict.maxStakeFraction != null &&
    plan.stakeFraction > verdict.maxStakeFraction
  ) {
    const scale = verdict.maxStakeFraction / plan.stakeFraction;
    finalPlan = {
      ...plan,
      stakeFraction: verdict.maxStakeFraction,
      quantity: BigInt(Math.floor(Number(plan.quantity) * scale)),
    };
    log.emit({ type: "plan", plan: finalPlan });
  }

  // Portfolio-level circuit breakers (idempotency, concurrency, exposure, daily loss).
  let lockRelease: (() => Promise<void>) | null = null;
  if (opts.portfolio) {
    lockRelease = await opts.portfolio.lock();
    try {
      await opts.portfolio.reload();
      const estCostUsd = finalPlan.stakeFraction * bankrollUsd;
      const gate = opts.portfolio.canOpen(
        finalPlan,
        estCostUsd,
        opts.portfolioLimits ?? DEFAULT_PORTFOLIO_LIMITS,
      );
      if (!gate.ok) {
        log.emit({ type: "portfolio_block", reason: gate.reason ?? "blocked" });
        log.emit({ type: "abstain", stage: "portfolio", reason: gate.reason ?? "blocked" });
        await lockRelease();
        lockRelease = null;
        return done(analysis, finalPlan, verdict, null);
      }
    } catch (err) {
      if (lockRelease) {
        await lockRelease();
        lockRelease = null;
      }
      throw err;
    }
  }

  let execution: ExecutionEnvelope | null = null;
  try {
    execution = await executor.execute(finalPlan, { runId });
    log.emit({ type: "execution", envelope: execution });

    if (opts.portfolio && execution.status === "filled") {
      await opts.portfolio.record(finalPlan, execution);
    }
  } finally {
    if (lockRelease) {
      await lockRelease();
    }
  }
  return done(analysis, finalPlan, verdict, execution);
}
