/**
 * Quorum desk server — live, event-sourced generative UI.
 *
 *   bun run serve            # http://localhost:8787
 *
 * Streams a desk run to the browser over Server-Sent Events: every analyst
 * signal, debate turn, proposal, sized plan, risk verdict, and execution
 * appears as it happens. Mirrors the CLI's event log — same typed events, same
 * pipeline — so the UI is a faithful window into the reasoning, not a mock.
 *
 * Endpoints:
 *   GET /                 the desk UI (self-contained HTML)
 *   GET /api/markets      tradable markets (JSON)
 *   GET /api/portfolio    positions + P&L (JSON)
 *   GET /api/run          SSE stream of one desk run (?signals=&prob=&asset=&market=)
 */

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

import { fetchTradableMarkets } from "../predict/server.js";
import { buildMarketContext } from "../desk/planner.js";
import { PredictExecutionProvider } from "../desk/executor.js";
import { runDesk } from "../desk/orchestrator.js";
import { HeuristicSignalSource, ManualSignalSource } from "../desk/heuristic.js";
import { GeminiSignalSource } from "../desk/gemini.js";
import { Portfolio } from "../desk/portfolio.js";
import { buildEvidence, writeEvidence } from "../desk/evidence.js";
import { activeAddress, loadKeypair } from "../chain/client.js";
import {
  ConsensusPublisher,
  deriveConsensusReading,
  oracleConfigured,
} from "../chain/consensus.js";
import { loadConfig } from "../desk/config.js";
import type { SignalSource } from "../desk/signals.js";
import { INDEX_HTML } from "./ui.js";

const PORT = Number(process.env.PORT ?? 8787);
const bigintReplacer = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, bigintReplacer), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });

const portfolio = await Portfolio.open();
const config = await loadConfig();
const quoteSender = Ed25519Keypair.generate().getPublicKey().toSuiAddress();
const paper = new PredictExecutionProvider({ mode: "paper", quoteSender });

function pickSource(params: URLSearchParams): SignalSource {
  const kind = params.get("signals") ?? config.signals;
  if (kind === "manual") return new ManualSignalSource(Number(params.get("prob") ?? "0.55"));
  if (kind === "llm") {
    const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY not set");
    return new GeminiSignalSource({ apiKey, model: config.gemini.model, maxTokens: config.gemini.maxTokens });
  }
  return new HeuristicSignalSource();
}

function runStream(params: URLSearchParams): Response {
  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (e: unknown) =>
        controller.enqueue(enc.encode(`data: ${JSON.stringify(e, bigintReplacer)}\n\n`));
      try {
        const assets = params.get("asset") ? [params.get("asset")!.toUpperCase()] : config.assets;
        const all = await fetchTradableMarkets();
        const pool = assets ? all.filter((m) => assets.includes(m.asset)) : all;
        const marketId = params.get("market");
        const market =
          (marketId && pool.find((m) => m.oracleId === marketId)) ||
          pool.find((m) => m.msToExpiry > 30 * 60_000) ||
          pool[0];
        if (!market) throw new Error("no tradable markets right now");

        const source = pickSource(params);
        const context = await buildMarketContext(market, { quoteSender });
        const result = await runDesk({
          context,
          signalSource: source,
          executor: paper,
          bankrollUsd: config.bankrollUsd,
          limits: config.risk,
          portfolioLimits: config.portfolio,
          kellyFractionCap: config.kellyFractionCap,
          portfolio,
          onEvent: send,
        });
        const ev = await buildEvidence(result);
        await writeEvidence(ev);

        // Publish the consensus probability on-chain (key + configured oracle
        // only — no DUSDC needed), then stream the result so the UI can show the
        // primitive being written live.
        let consensus:
          | { digest: string; explorer: string; probUpBps: number; confidenceBps: number; disagreementBps: number }
          | undefined;
        if (oracleConfigured() && activeAddress() && !result.analysis.proposal.abstain) {
          try {
            const reading = deriveConsensusReading(context, result, ev.hash);
            const pub = await new ConsensusPublisher(loadKeypair()).publish(reading);
            consensus = {
              digest: pub.digest,
              explorer: pub.explorer,
              probUpBps: reading.probUpBps,
              confidenceBps: reading.confidenceBps,
              disagreementBps: reading.disagreementBps,
            };
            send({ type: "consensus_published", ...consensus });
          } catch (err) {
            send({ type: "consensus_error", message: String(err) });
          }
        }
        send({ type: "done", runId: result.runId, evidenceHash: ev.hash, consensus });
      } catch (err) {
        send({ type: "error", message: String(err) });
      }
      controller.close();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "access-control-allow-origin": "*",
    },
  });
}

const server = Bun.serve({
  port: PORT,
  // SSE runs (esp. the Gemini debate: 4 analysts + bull + bear + trader) outlive
  // the 10s default; 255s is Bun's max. We also stream events as they happen.
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/markets") {
      const m = await fetchTradableMarkets();
      return json(
        m.slice(0, 30).map((x) => ({
          oracleId: x.oracleId,
          asset: x.asset,
          minsToExpiry: Math.round(x.msToExpiry / 60_000),
          expiry: x.expiry.toISOString(),
        })),
      );
    }
    if (url.pathname === "/api/portfolio") {
      return json({
        open: portfolio.open_().length,
        exposureUsd: portfolio.openExposureUsd(),
        realizedPnlUsd: portfolio.realizedPnlUsd(),
        positions: portfolio.all(),
      });
    }
    if (url.pathname === "/api/run") return runStream(url.searchParams);

    // Serve Next.js static export from the "web" directory
    let filePath = url.pathname;
    if (filePath === "/") filePath = "/index.html";
    if (filePath === "/dashboard") filePath = "/dashboard.html";

    const file = Bun.file(import.meta.dir + "/../../web" + filePath);
    if (await file.exists()) {
      return new Response(file);
    }

    return new Response("not found", { status: 404 });
  },
});

console.log(`Quorum desk UI → http://localhost:${server.port}`);
