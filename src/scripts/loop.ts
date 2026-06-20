/**
 * Continuous desk — the always-on loop (fixes "single-shot").
 *
 *   bun run loop                                   # keyless heuristic, paper
 *   bun run loop --signals manual --prob 0.6       # analyst view across markets
 *   bun run loop --interval 120 --count 3          # every 2 min, top 3 markets
 *
 * Each tick: (1) settle any positions whose oracle has settled, then (2) scan
 * the top N tradable markets and run the desk on each, with the portfolio's
 * circuit breakers (idempotency, concurrency, exposure, daily-loss kill switch)
 * gating every entry. Ctrl-C to stop.
 */

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

import { fetchTradableMarkets, fetchMarkets } from "../predict/server.js";
import { buildMarketContext } from "../desk/planner.js";
import { PredictExecutionProvider } from "../desk/executor.js";
import { runDesk } from "../desk/orchestrator.js";
import { HeuristicSignalSource, ManualSignalSource } from "../desk/heuristic.js";
import { GeminiSignalSource } from "../desk/gemini.js";
import { Portfolio } from "../desk/portfolio.js";
import { buildEvidence, writeEvidence } from "../desk/evidence.js";
import { loadConfig, type DeskConfig } from "../desk/config.js";
import type { SignalSource } from "../desk/signals.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function flag(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

function makeSignalSource(config: DeskConfig): SignalSource {
  const kind = flag("signals") ?? config.signals;
  if (kind === "manual") {
    const p = Number(flag("prob"));
    if (!Number.isFinite(p)) throw new Error("--signals manual requires --prob");
    return new ManualSignalSource(p);
  }
  if (kind === "llm") {
    const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
    if (!apiKey) throw new Error("--signals llm needs GEMINI_API_KEY");
    return new GeminiSignalSource({ apiKey, model: config.gemini.model, maxTokens: config.gemini.maxTokens });
  }
  return new HeuristicSignalSource();
}

async function settleDue(portfolio: Portfolio): Promise<void> {
  const open = portfolio.open_();
  if (open.length === 0) return;
  const markets = await fetchMarkets();
  for (const p of open) {
    const m = markets.find((x) => x.oracleId === p.oracleId);
    if (m && m.status === "settled" && m.settlementPrice != null) {
      const settled = await portfolio.settleOracle(p.oracleId, m.settlementPrice);
      for (const s of settled) {
        console.log(`   settled ${s.asset} ${s.direction} @ ${s.strike} → ${s.status} P&L $${(s.realizedPnlUsd ?? 0).toFixed(2)}`);
      }
    }
  }
}

async function main(): Promise<void> {
  const config = await loadConfig();
  const intervalMs = Number(flag("interval", "120")) * 1000;
  const count = Number(flag("count", "3"));
  const bankrollUsd = flag("bankroll") ? Number(flag("bankroll")) : config.bankrollUsd;
  const assets = flag("asset") ? [flag("asset")!.toUpperCase()] : config.assets;
  const signalSource = makeSignalSource(config);
  const portfolio = await Portfolio.open();
  const quoteSender = Ed25519Keypair.generate().getPublicKey().toSuiAddress();
  const executor = new PredictExecutionProvider({ mode: "paper", quoteSender });

  console.log(
    `Quorum loop · signals=${signalSource.id} · every ${intervalMs / 1000}s · top ${count} · ` +
      `asset=${assets?.join(",") ?? "any"} · paper`,
  );

  let tick = 0;
  for (;;) {
    tick++;
    const ts = new Date().toISOString().slice(11, 19);
    console.log(`\n──── tick ${tick} @ ${ts} ────`);
    try {
      await settleDue(portfolio);
      const markets = (await fetchTradableMarkets())
        .filter((m) => m.msToExpiry > 10 * 60_000)
        .filter((m) => !assets || assets.includes(m.asset))
        .slice(0, count);

      for (const market of markets) {
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
        });
        const last = result.events.at(-1);
        const tag =
          result.execution?.status === "filled"
            ? `TRADE ${result.plan?.direction.toUpperCase()} $${result.execution.amountUsd.toFixed(2)}`
            : last?.type === "abstain"
              ? `abstain (${last.reason})`
              : "no trade";
        console.log(`   ${market.asset} ${market.oracleId.slice(0, 10)}… ${context.minsToExpiry}m → ${tag}`);
        await writeEvidence(await buildEvidence(result));
      }
      console.log(
        `   portfolio: ${portfolio.open_().length} open · exposure $${portfolio.openExposureUsd().toFixed(2)} · realized $${portfolio.realizedPnlUsd().toFixed(2)}`,
      );
    } catch (err) {
      console.error(`   tick error (continuing): ${err}`);
    }
    await sleep(intervalMs);
  }
}

main().catch((err) => {
  console.error("loop failed:", err);
  process.exit(1);
});
