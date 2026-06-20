/**
 * Quorum Consensus Oracle CLI — publish the desk's probability on-chain and read
 * it back the way any other protocol would.
 *
 *   bun run oracle publish [--market <id>] [--signals heuristic|llm]
 *       Run the desk on one market (paper — no DUSDC needed) and publish its
 *       consensus probability on-chain. Needs SUI_PRIVATE_KEY + QUORUM_ORACLE_*.
 *
 *   bun run oracle read <oracleId>
 *       Keyless consumer read of the latest consensus for a Predict oracle.
 *
 *   bun run oracle consumer <oracleId>
 *       Demo downstream protocol: reads the consensus and shows how an option
 *       vault would size an allocation from it — proving composability.
 *
 * Env (see .env.example):
 *   QUORUM_ORACLE_PACKAGE / QUORUM_ORACLE_OBJECT / QUORUM_ORACLE_CAP
 */

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

import { loadKeypair } from "../chain/client.js";
import {
  ConsensusPublisher,
  deriveConsensusReading,
  oracleConfigured,
  readConsensus,
  type OnChainReading,
} from "../chain/consensus.js";
import { fetchTradableMarkets } from "../predict/server.js";
import { buildMarketContext } from "../desk/planner.js";
import { PredictExecutionProvider } from "../desk/executor.js";
import { runDesk } from "../desk/orchestrator.js";
import { HeuristicSignalSource } from "../desk/heuristic.js";
import { GeminiSignalSource } from "../desk/gemini.js";
import { buildEvidence } from "../desk/evidence.js";
import { loadConfig } from "../desk/config.js";
import type { SignalSource } from "../desk/signals.js";

function flag(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const pct = (bps: number) => `${(bps / 100).toFixed(1)}%`;

function printReading(oracleId: string, r: OnChainReading): void {
  console.log(`\n📡 Consensus for oracle ${oracleId.slice(0, 12)}…`);
  console.log(`   P(up)        ${pct(r.probUpBps)}`);
  console.log(`   confidence   ${pct(r.confidenceBps)}`);
  console.log(`   disagreement ${pct(r.disagreementBps)}`);
  console.log(`   market P(up) ${pct(r.marketProbUpBps)}`);
  console.log(`   edge         ${pct(r.probUpBps - r.marketProbUpBps)}`);
  console.log(`   published    ${new Date(r.publishedAtMs).toISOString()}`);
}

async function doPublish(): Promise<void> {
  if (!oracleConfigured()) {
    throw new Error(
      "Set QUORUM_ORACLE_PACKAGE / QUORUM_ORACLE_OBJECT / QUORUM_ORACLE_CAP in .env first.",
    );
  }
  const signer = loadKeypair();
  const config = await loadConfig();

  const kind = flag("signals") ?? "heuristic";
  let source: SignalSource;
  if (kind === "llm") {
    const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
    if (!apiKey) throw new Error("--signals llm needs GEMINI_API_KEY in env.");
    source = new GeminiSignalSource({
      apiKey,
      model: config.gemini.model,
      maxTokens: config.gemini.maxTokens,
    });
  } else {
    source = new HeuristicSignalSource();
  }

  const all = await fetchTradableMarkets();
  const marketId = flag("market");
  const market =
    (marketId && all.find((m) => m.oracleId === marketId)) ||
    all.find((m) => m.msToExpiry > 30 * 60_000) ||
    all[0];
  if (!market) throw new Error("No tradable markets right now — re-run shortly.");

  // Paper execution: we only need the analysis, not a funded mint, to publish.
  const quoteSender = Ed25519Keypair.generate().getPublicKey().toSuiAddress();
  const context = await buildMarketContext(market, { quoteSender });
  const result = await runDesk({
    context,
    signalSource: source,
    executor: new PredictExecutionProvider({ mode: "paper", quoteSender }),
    bankrollUsd: config.bankrollUsd,
    limits: config.risk,
    kellyFractionCap: config.kellyFractionCap,
  });

  if (result.analysis.proposal.abstain) {
    console.log("Desk abstained on this market — nothing to publish. Try another --market.");
    return;
  }

  const evidence = await buildEvidence(result, { signer });
  const reading = deriveConsensusReading(context, result, evidence.hash);
  const pub = await new ConsensusPublisher(signer).publish(reading);

  console.log(`\n🔮 Published consensus for ${market.asset} (${market.oracleId.slice(0, 12)}…)`);
  console.log(
    `   P(up) ${pct(reading.probUpBps)} · conf ${pct(reading.confidenceBps)} · ` +
      `disagreement ${pct(reading.disagreementBps)} · evidence ${reading.evidenceHashHex.slice(0, 16)}…`,
  );
  console.log(`   tx ${pub.digest}`);
  console.log(`   ${pub.explorer}`);
}

async function doRead(oracleId: string): Promise<void> {
  const r = await readConsensus(oracleId);
  if (!r) {
    console.log(`No consensus published yet for ${oracleId}. Run \`bun run oracle publish\` first.`);
    return;
  }
  printReading(oracleId, r);
}

/**
 * Illustrative downstream consumer: an option vault that reads Quorum's
 * consensus and sizes a directional tilt from it, discounted by disagreement.
 * This is the composability proof — a *different* protocol reading the primitive.
 */
async function doConsumer(oracleId: string): Promise<void> {
  const r = await readConsensus(oracleId);
  if (!r) {
    console.log(`No consensus for ${oracleId} yet — publish one first.`);
    return;
  }
  printReading(oracleId, r);

  const edgeBps = r.probUpBps - r.marketProbUpBps; // signed: + favours UP
  const confidence = r.confidenceBps / 10_000;
  const trust = 1 - r.disagreementBps / 10_000; // unanimous desks earn more trust
  // Toy sizing rule: tilt ∝ edge · confidence · (1 − disagreement), capped.
  const rawTiltBps = edgeBps * confidence * trust;
  const tiltBps = Math.max(-2_000, Math.min(2_000, Math.round(rawTiltBps)));
  const side = tiltBps >= 0 ? "UP" : "DOWN";

  console.log(`\n🏦 Vault (downstream consumer) decision`);
  console.log(
    `   reads Quorum consensus → tilts ${pct(Math.abs(tiltBps))} of the book toward ${side}`,
  );
  console.log(
    `   (edge ${pct(edgeBps)} × confidence ${(confidence * 100).toFixed(0)}% × ` +
      `trust ${(trust * 100).toFixed(0)}%, capped at 20%)`,
  );
  if (Math.abs(tiltBps) < 25) {
    console.log("   → consensus too weak/divided: vault stays market-neutral.");
  }
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === "publish") return doPublish();
  if (cmd === "read") {
    const id = process.argv[3];
    if (!id) throw new Error("usage: bun run oracle read <oracleId>");
    return doRead(id);
  }
  if (cmd === "consumer") {
    const id = process.argv[3];
    if (!id) throw new Error("usage: bun run oracle consumer <oracleId>");
    return doConsumer(id);
  }
  console.log("usage: bun run oracle <publish|read|consumer> [args]");
  process.exit(1);
}

main().catch((err) => {
  console.error("oracle command failed:", err);
  process.exit(1);
});
