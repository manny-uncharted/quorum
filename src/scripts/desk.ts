/**
 * Quorum desk runner — the end-to-end loop for all three personas.
 *
 *   bun run desk                                  # beginner: keyless heuristic, paper
 *   bun run desk --signals manual --prob 0.62     # analyst: bring your own view
 *   bun run desk --signals llm                    # trader: full Gemini agent debate
 *   bun run desk --mode testnet                   # execute a real mint (needs funds)
 *
 * Flags:
 *   --signals heuristic|manual|llm   (default heuristic)
 *   --prob <0..1>                    subjective P(up) for manual mode
 *   --mode paper|testnet             (default paper)
 *   --bankroll <usd>                 (default 1000)
 *   --market <oracleId>              (default: nearest with comfortable expiry)
 */

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

import { loadKeypair } from "../chain/client.js";
import { fetchTradableMarkets } from "../predict/server.js";
import { buildMarketContext } from "../desk/planner.js";
import { PredictExecutionProvider, type ExecutionMode } from "../desk/executor.js";
import { runDesk } from "../desk/orchestrator.js";
import { HeuristicSignalSource, ManualSignalSource } from "../desk/heuristic.js";
import { GeminiSignalSource } from "../desk/gemini.js";
import { Portfolio } from "../desk/portfolio.js";
import { buildEvidence, writeEvidence } from "../desk/evidence.js";
import {
  ConsensusPublisher,
  deriveConsensusReading,
  oracleConfigured,
} from "../chain/consensus.js";
import { loadConfig, type DeskConfig } from "../desk/config.js";
import type { SignalSource } from "../desk/signals.js";
import type { DeskEvent } from "../desk/events.js";

function flag(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

function renderEvent(e: DeskEvent): void {
  switch (e.type) {
    case "market_context": {
      const c = e.context;
      console.log(
        `\n📊 ${c.market.asset}  oracle ${c.market.oracleId.slice(0, 10)}…  expires in ${c.minsToExpiry}m`,
      );
      console.log(
        `   forward ${c.forward.toLocaleString()}  strike ${c.strike.toLocaleString()} (ATM)  ` +
          `risk-neutral P(up) ${(c.riskNeutralProbUp * 100).toFixed(1)}%  market ${(c.marketProbUp * 100).toFixed(1)}%`,
      );
      break;
    }
    case "analyst_signal":
      console.log(
        `   🔎 ${e.analyst.padEnd(10)} ${e.signal.lean.toUpperCase().padEnd(8)} ` +
          `str ${e.signal.strength.toFixed(2)} conf ${e.signal.confidence.toFixed(2)}  ${e.signal.summary}`,
      );
      break;
    case "debate_turn":
      console.log(`   🗣  ${e.speaker.toUpperCase()}: ${e.content}`);
      break;
    case "proposal":
      console.log(
        `\n🧠 Proposal: subjective P(up) ${(e.proposal.subjectiveProbUp * 100).toFixed(1)}%  ` +
          `conf ${e.proposal.confidence.toFixed(2)}  abstain=${e.proposal.abstain}`,
      );
      console.log(`   ${e.proposal.reasoning}`);
      break;
    case "plan":
      console.log(
        `\n📐 Plan: ${e.plan.direction.toUpperCase()}  edge ${(e.plan.edge * 100).toFixed(1)}%  ` +
          `stake ${(e.plan.stakeFraction * 100).toFixed(1)}%  qty ${e.plan.quantity}`,
      );
      break;
    case "risk_verdict":
      console.log(`\n🛡  Risk: ${e.verdict.decision.toUpperCase()} — ${e.verdict.reasoning}`);
      for (const b of e.verdict.circuitBreakers) console.log(`     • ${b}`);
      break;
    case "execution":
      console.log(
        `\n⚡ Execution [${e.envelope.surface}/${e.envelope.status}] via ${e.envelope.provider}  ` +
          `cost ≈ ${e.envelope.amountUsd.toFixed(4)} DUSDC  tx ${e.envelope.txHash}`,
      );
      if (e.envelope.metadata?.explorer) console.log(`   ${e.envelope.metadata.explorer}`);
      break;
    case "portfolio_block":
      console.log(`\n⛔ Portfolio breaker: ${e.reason}`);
      break;
    case "abstain":
      console.log(`\n🚫 ABSTAIN @ ${e.stage}: ${e.reason}`);
      break;
  }
}

function pickSignalSource(config: DeskConfig): SignalSource {
  const kind = flag("signals") ?? config.signals;
  if (kind === "heuristic") return new HeuristicSignalSource();
  if (kind === "manual") {
    const p = Number(flag("prob"));
    if (!Number.isFinite(p)) throw new Error("--signals manual requires --prob <0..1>");
    return new ManualSignalSource(p);
  }
  if (kind === "llm") {
    const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
    if (!apiKey) throw new Error("--signals llm needs GEMINI_API_KEY (or GOOGLE_API_KEY) in env.");
    return new GeminiSignalSource({ apiKey, model: config.gemini.model, maxTokens: config.gemini.maxTokens });
  }
  throw new Error(`unknown --signals ${kind}`);
}

async function main(): Promise<void> {
  const config = await loadConfig();
  const mode = (flag("mode", "paper") as ExecutionMode) ?? "paper";
  const bankrollUsd = flag("bankroll") ? Number(flag("bankroll")) : config.bankrollUsd;
  const marketId = flag("market");
  const assets = flag("asset") ? [flag("asset")!.toUpperCase()] : config.assets;

  const allMarkets = await fetchTradableMarkets();
  const markets = assets ? allMarkets.filter((m) => assets.includes(m.asset)) : allMarkets;
  const market =
    (marketId && markets.find((m) => m.oracleId === marketId)) ||
    markets.find((m) => m.msToExpiry > 30 * 60_000) ||
    markets[0];
  if (!market) throw new Error("No tradable markets for the selected asset(s) — re-run shortly.");

  // Executor + quote sender + optional signer (for evidence + testnet).
  let executor: PredictExecutionProvider;
  let quoteSender: string;
  let signer: ReturnType<typeof loadKeypair> | undefined;
  if (mode === "testnet") {
    signer = loadKeypair();
    const managerId = process.env.PREDICT_MANAGER_ID?.trim();
    if (!managerId) throw new Error("testnet mode needs PREDICT_MANAGER_ID in .env (run `bun run spike` once).");
    quoteSender = signer.getPublicKey().toSuiAddress();
    executor = new PredictExecutionProvider({ mode, keypair: signer, managerId, quoteSender });
  } else {
    quoteSender = Ed25519Keypair.generate().getPublicKey().toSuiAddress();
    executor = new PredictExecutionProvider({ mode: "paper", quoteSender });
  }

  const signalSource = pickSignalSource(config);
  const portfolio = await Portfolio.open();
  console.log(
    `Quorum desk · signals=${signalSource.id} · mode=${mode} · bankroll=$${bankrollUsd} · ` +
      `asset=${assets?.join(",") ?? "any"} · minEdge=${(config.risk.minEdge * 100).toFixed(1)}%`,
  );

  const context = await buildMarketContext(market, { quoteSender });
  const result = await runDesk({
    context,
    signalSource,
    executor,
    bankrollUsd,
    limits: config.risk,
    portfolioLimits: config.portfolio,
    kellyFractionCap: config.kellyFractionCap,
    portfolio,
    onEvent: renderEvent,
  });

  // Signed, verifiable evidence bundle for every run.
  const evidence = await buildEvidence(result, { signer });
  const evidencePath = await writeEvidence(evidence);
  console.log(
    `\n📜 Evidence ${evidence.hash.slice(0, 16)}…${evidence.signature ? " (signed)" : ""} → ${evidencePath}`,
  );

  // Publish the desk's consensus probability on-chain as a reusable primitive.
  // Needs only the desk key + a configured oracle — not DUSDC — so it runs even
  // when no trade was placed. Other protocols read this via `consensus::read`.
  if (signer && oracleConfigured() && !result.analysis.proposal.abstain) {
    try {
      const reading = deriveConsensusReading(context, result, evidence.hash);
      const pub = await new ConsensusPublisher(signer).publish(reading);
      console.log(
        `\n🔮 Consensus published on-chain — P(up) ${(reading.probUpBps / 100).toFixed(1)}% · ` +
          `conf ${(reading.confidenceBps / 100).toFixed(0)}% · disagreement ${(reading.disagreementBps / 100).toFixed(0)}%`,
      );
      console.log(`   oracle ${pub.objectId.slice(0, 10)}…  ${pub.explorer}`);
    } catch (err) {
      console.error("consensus publish skipped:", String(err));
    }
  }

  const outcome = result.execution
    ? `${result.execution.surface}/${result.execution.status}`
    : "no trade";
  console.log(
    `📈 Portfolio: ${portfolio.open_().length} open · exposure $${portfolio.openExposureUsd().toFixed(2)} · ` +
      `realized P&L $${portfolio.realizedPnlUsd().toFixed(2)}`,
  );
  console.log(`✅ Run ${result.runId.slice(0, 8)} complete — ${outcome}. ${result.events.length} events.`);
}

main().catch((err) => {
  console.error("desk run failed:", err);
  process.exit(1);
});
