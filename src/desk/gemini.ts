/**
 * Gemini multi-agent signal source — the experienced-trader brain.
 *
 * Runs the four binary-native analysts (volatility, momentum, catalyst, flow),
 * a bull/bear debate, and a trader synthesis through the `@veridex/agents`
 * runtime (the same kernel the vendored fabric uses). The trader emits a single
 * calibrated `subjectiveProbUp`; the deterministic quant core does the rest.
 *
 * Agents reason over the on-chain MarketContext (surface, forward/spot, strike,
 * baselines, time-to-expiry). They are tool-free by design here — the context is
 * the evidence — which keeps every call cheap, auditable, and reproducible. Wiring
 * live crypto data tools (price history, funding, news) is a clean future add.
 */

import {
  GeminiProvider,
  createAgent,
  type AgentDefinition,
  type ModelProvider,
  type RuntimeOptions,
} from "@veridex/agents";

import { parseStructured } from "../fabric/orchestration/structuredOutput.js";
import { fetchMarketData, summarizeMarketData } from "./marketdata.js";
import {
  bearResearcherInstructions,
  bullResearcherInstructions,
  catalystAnalystInstructions,
  flowAnalystInstructions,
  momentumAnalystInstructions,
  traderInstructions,
  volatilityAnalystInstructions,
} from "./instructions.js";
import { AnalystSignal, BinaryProposal } from "./schemas.js";
import type { AnalyzeHooks, AnalystOutput, DeskAnalysis, SignalSource } from "./signals.js";
import type { AnalystKind } from "./events.js";
import type { MarketContext } from "./types.js";

const ANALYST_JSON =
  'Respond with ONLY a JSON object, no prose, no code fences: ' +
  '{"lean":"up|down|neutral","strength":<0..1>,"confidence":<0..1>,"summary":"<2-4 sentences>"}';

const PROPOSAL_JSON =
  'Respond with ONLY a JSON object, no prose, no code fences: ' +
  '{"subjectiveProbUp":<0..1>,"confidence":<0..1>,"abstain":<true|false>,' +
  '"keyDrivers":["..."],"reasoning":"<concise thesis>"}';

/** The minimal runtime result shape we depend on from `runtime.run`. */
interface RunResult {
  output: string;
  run?: { state?: string; error?: string };
}

function withName(provider: ModelProvider, name: string): ModelProvider {
  return new Proxy(provider, {
    get: (t, p, r) => (p === "name" ? name : Reflect.get(t, p, r)),
  });
}

function renderContext(ctx: MarketContext): string {
  return [
    `MARKET CONTEXT`,
    `- Underlying: ${ctx.market.asset}`,
    `- Oracle: ${ctx.market.oracleId}`,
    `- Expiry: ${ctx.market.expiry.toISOString()} (${ctx.minsToExpiry} minutes away)`,
    `- Strike: ${ctx.strike.toLocaleString()}`,
    `- Forward: ${ctx.forward.toLocaleString()}  Spot: ${ctx.spot.toLocaleString()}`,
    `- Risk-neutral P(up) (driftless baseline): ${(ctx.riskNeutralProbUp * 100).toFixed(2)}%`,
    `- Market-implied P(up) (what you pay): ${(ctx.marketProbUp * 100).toFixed(2)}%`,
    `- SVI surface: a=${ctx.svi.a.toExponential(3)} b=${ctx.svi.b.toExponential(3)} ` +
      `rho=${ctx.svi.rho.toFixed(4)} m=${ctx.svi.m.toExponential(3)} sigma=${ctx.svi.sigma.toExponential(3)}`,
  ].join("\n");
}

export interface GeminiOptions {
  apiKey: string;
  model?: string;
  /** Per-agent token cap. */
  maxTokens?: number;
}

export class GeminiSignalSource implements SignalSource {
  readonly id = "gemini";
  private readonly runtimeOptions: RuntimeOptions;
  private readonly model: string;
  private readonly maxTokens: number;

  constructor(opts: GeminiOptions) {
    if (!opts.apiKey) throw new Error("GeminiSignalSource requires an apiKey (GEMINI_API_KEY).");
    this.model = opts.model ?? "gemini-3.5-flash";
    this.maxTokens = opts.maxTokens ?? 8192;
    const provider = withName(new GeminiProvider({ apiKey: opts.apiKey, model: this.model }), "google");
    this.runtimeOptions = {
      enableTracing: false,
      modelProviders: { quick: provider, deep: provider },
    } as RuntimeOptions;
  }

  private def(id: string, name: string, instructions: string): AgentDefinition {
    return {
      id,
      name,
      model: { provider: "google", model: this.model },
      instructions,
      tools: [],
      maxTokens: this.maxTokens,
    } as AgentDefinition;
  }

  private async run(def: AgentDefinition, userMessage: string): Promise<string> {
    const runtime = createAgent(def, this.runtimeOptions);
    const result = (await runtime.run(userMessage)) as RunResult;
    if (result.run?.state === "failed") {
      throw new Error(`Agent "${def.name}" failed: ${result.run.error ?? "unknown"}`);
    }
    return result.output;
  }

  private async analyst(
    kind: AnalystKind,
    instructions: string,
    contextMsg: string,
    hooks?: AnalyzeHooks,
  ): Promise<AnalystOutput> {
    // A single flaky/over-budget analyst must not abort the whole debate —
    // degrade to a neutral, zero-confidence signal that records the failure.
    let out: AnalystOutput;
    try {
      const raw = await this.run(
        this.def(`quorum:${kind}-analyst`, `${kind} analyst`, instructions),
        `${contextMsg}\n\n${ANALYST_JSON}`,
      );
      out = { analyst: kind, signal: parseStructured(raw, AnalystSignal) };
    } catch (err) {
      out = {
        analyst: kind,
        signal: { lean: "neutral", strength: 0, confidence: 0, summary: `analysis unavailable: ${String(err).slice(0, 120)}` },
      };
    }
    hooks?.onAnalyst?.(out); // stream the moment this analyst resolves
    return out;
  }

  async analyze(ctx: MarketContext, hooks?: AnalyzeHooks): Promise<DeskAnalysis> {
    const md = await fetchMarketData(ctx.market.asset);
    const contextMsg =
      renderContext(ctx) +
      `\n\nLIVE ${ctx.market.asset} MARKET DATA (real spot market):\n${summarizeMarketData(md)}`;

    // 1) Analysts in parallel — each streams via hooks as it resolves.
    const analystSignals = await Promise.all([
      this.analyst("volatility", volatilityAnalystInstructions(), contextMsg, hooks),
      this.analyst("momentum", momentumAnalystInstructions(), contextMsg, hooks),
      this.analyst("catalyst", catalystAnalystInstructions(), contextMsg, hooks),
      this.analyst("flow", flowAnalystInstructions(), contextMsg, hooks),
    ]);

    const signalDigest = analystSignals
      .map((a) => `- ${a.analyst}: ${a.signal.lean} (str ${a.signal.strength}, conf ${a.signal.confidence}) — ${a.signal.summary}`)
      .join("\n");

    // 2) Bull then bear (bear sees the bull case) — stream each turn.
    const bull = await this.run(
      this.def("quorum:bull", "bull researcher", bullResearcherInstructions()),
      `${contextMsg}\n\nANALYST SIGNALS:\n${signalDigest}\n\nMake the bull case in 3-5 sentences.`,
    );
    hooks?.onDebate?.("bull", bull);
    const bear = await this.run(
      this.def("quorum:bear", "bear researcher", bearResearcherInstructions()),
      `${contextMsg}\n\nANALYST SIGNALS:\n${signalDigest}\n\nBULL CASE:\n${bull}\n\nMake the bear case in 3-5 sentences.`,
    );
    hooks?.onDebate?.("bear", bear);

    // 3) Trader synthesis → single subjective probability.
    const proposalRaw = await this.run(
      this.def("quorum:trader", "trader", traderInstructions()),
      `${contextMsg}\n\nANALYST SIGNALS:\n${signalDigest}\n\nBULL:\n${bull}\n\nBEAR:\n${bear}\n\n${PROPOSAL_JSON}`,
    );
    const proposal = parseStructured(proposalRaw, BinaryProposal);

    return { analystSignals, debate: { bull, bear }, proposal };
  }
}
