/**
 * Quorum Consensus Oracle — client for the on-chain "wisdom of agents" feed.
 *
 * Publishes the desk's consensus probability for a Predict market to the
 * `quorum_oracle::consensus` package and reads it back the way any other
 * protocol would. Probabilities cross the boundary as basis points (0..=10_000)
 * so neither side touches floats.
 *
 * Deploy once with the Sui CLI, then wire the three ids into `.env`:
 *   QUORUM_ORACLE_PACKAGE   the published package id
 *   QUORUM_ORACLE_OBJECT    the shared ConsensusOracle object id
 *   QUORUM_ORACLE_CAP       the PublisherCap object id (owned by the desk)
 */

import { Transaction } from "@mysten/sui/transactions";
import { bcs } from "@mysten/sui/bcs";
import { fromHex } from "@mysten/sui/utils";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

import { client } from "./client.js";
import { CLOCK_OBJECT_ID } from "./constants.js";
import type { DeskRunResult } from "../desk/orchestrator.js";
import type { AnalystOutput } from "../desk/signals.js";
import type { MarketContext } from "../desk/types.js";

export const QUORUM_ORACLE = {
  packageId: process.env.QUORUM_ORACLE_PACKAGE?.trim() ?? "",
  objectId: process.env.QUORUM_ORACLE_OBJECT?.trim() ?? "",
  publisherCapId: process.env.QUORUM_ORACLE_CAP?.trim() ?? "",
} as const;

/** True once all three oracle ids are present in the environment. */
export function oracleConfigured(): boolean {
  return Boolean(
    QUORUM_ORACLE.packageId &&
      QUORUM_ORACLE.objectId &&
      QUORUM_ORACLE.publisherCapId,
  );
}

/** A consensus reading in on-chain (basis-point) form. */
export interface ConsensusReading {
  oracleId: string;
  asset: string;
  probUpBps: number;
  confidenceBps: number;
  disagreementBps: number;
  marketProbUpBps: number;
  expiryMs: number;
  /** SHA-256 hex of the signed evidence bundle (no 0x prefix). */
  evidenceHashHex: string;
  runId: string;
}

/** A reading as read back from chain (for consumers). */
export interface OnChainReading {
  probUpBps: number;
  confidenceBps: number;
  disagreementBps: number;
  marketProbUpBps: number;
  expiryMs: number;
  publishedAtMs: number;
}

const clampBps = (p: number): number =>
  Math.max(0, Math.min(10_000, Math.round(p * 10_000)));

/**
 * Analyst disagreement index in [0,1]: the variance of per-analyst directional
 * conviction (lean·strength, each in [-1,1]). 0 = unanimous, →1 = maximally
 * split (half strongly up, half strongly down). A first-class signal consumers
 * can use to discount the consensus when the desk is internally divided.
 */
export function disagreementIndex(signals: AnalystOutput[]): number {
  if (signals.length === 0) return 0;
  const scores = signals.map(({ signal }) => {
    const dir = signal.lean === "up" ? 1 : signal.lean === "down" ? -1 : 0;
    return dir * signal.strength;
  });
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const variance =
    scores.reduce((a, s) => a + (s - mean) ** 2, 0) / scores.length;
  return Math.max(0, Math.min(1, variance));
}

/** Project a finished desk run + its evidence hash into a publishable reading. */
export function deriveConsensusReading(
  context: MarketContext,
  result: DeskRunResult,
  evidenceHashHex: string,
): ConsensusReading {
  const { proposal, analystSignals } = result.analysis;
  return {
    oracleId: context.market.oracleId,
    asset: context.market.asset,
    probUpBps: clampBps(proposal.subjectiveProbUp),
    confidenceBps: clampBps(proposal.confidence),
    disagreementBps: clampBps(disagreementIndex(analystSignals)),
    marketProbUpBps: clampBps(context.marketProbUp),
    expiryMs: context.market.raw.expiry,
    evidenceHashHex: evidenceHashHex.startsWith("0x")
      ? evidenceHashHex.slice(2)
      : evidenceHashHex,
    runId: result.runId,
  };
}

/** Result of a publish: the tx digest and the shared oracle object written to. */
export interface PublishResult {
  digest: string;
  objectId: string;
  explorer: string;
}

/**
 * Writes consensus readings to the on-chain oracle. Requires the publisher
 * keypair (the desk's Sui key) and a configured oracle (see {@link oracleConfigured}).
 */
export class ConsensusPublisher {
  constructor(
    private readonly keypair: Ed25519Keypair,
    private readonly cfg = QUORUM_ORACLE,
  ) {
    if (!cfg.packageId || !cfg.objectId || !cfg.publisherCapId) {
      throw new Error(
        "Consensus oracle not configured: set QUORUM_ORACLE_PACKAGE/OBJECT/CAP in .env.",
      );
    }
  }

  /** Returns a publisher when the oracle is configured, else null. */
  static maybe(keypair: Ed25519Keypair): ConsensusPublisher | null {
    return oracleConfigured() ? new ConsensusPublisher(keypair) : null;
  }

  /** Append a `consensus::publish` call to an existing PTB. */
  addPublish(tx: Transaction, reading: ConsensusReading): void {
    tx.moveCall({
      target: `${this.cfg.packageId}::consensus::publish`,
      arguments: [
        tx.object(this.cfg.objectId),
        tx.object(this.cfg.publisherCapId),
        tx.pure.id(reading.oracleId),
        tx.pure.string(reading.asset),
        tx.pure.u64(reading.probUpBps),
        tx.pure.u64(reading.confidenceBps),
        tx.pure.u64(reading.disagreementBps),
        tx.pure.u64(reading.marketProbUpBps),
        tx.pure.u64(reading.expiryMs),
        tx.pure.vector("u8", Array.from(fromHex(reading.evidenceHashHex))),
        tx.pure.string(reading.runId),
        tx.object(CLOCK_OBJECT_ID),
      ],
    });
  }

  /** Build, sign, and execute a publish; returns the digest + explorer link. */
  async publish(reading: ConsensusReading): Promise<PublishResult> {
    const tx = new Transaction();
    this.addPublish(tx, reading);
    const res = await client.signAndExecuteTransaction({
      signer: this.keypair,
      transaction: tx,
      options: { showEffects: true },
    });
    await client.waitForTransaction({ digest: res.digest });
    if (res.effects?.status?.status !== "success") {
      throw new Error(
        `consensus publish failed: ${JSON.stringify(res.effects?.status)}`,
      );
    }
    return {
      digest: res.digest,
      objectId: this.cfg.objectId,
      explorer: `https://suiscan.xyz/testnet/tx/${res.digest}`,
    };
  }
}

/**
 * Read the latest consensus for a Predict oracle exactly as an external
 * consumer (vault, liquidation engine, another desk) would — a keyless
 * `devInspect` against the public `consensus::read` view. Returns null when no
 * reading has been published for that oracle yet.
 */
export async function readConsensus(
  oracleId: string,
  opts: { packageId?: string; objectId?: string } = {},
): Promise<OnChainReading | null> {
  const packageId = opts.packageId ?? QUORUM_ORACLE.packageId;
  const objectId = opts.objectId ?? QUORUM_ORACLE.objectId;
  if (!packageId || !objectId) {
    throw new Error("readConsensus: package/object id not configured.");
  }

  const tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::consensus::read`,
    arguments: [tx.object(objectId), tx.pure.id(oracleId)],
  });

  const res = await client.devInspectTransactionBlock({
    // Any address works for a read-only view.
    sender: "0x000000000000000000000000000000000000000000000000000000000000dead",
    transactionBlock: tx,
  });

  // A missing reading aborts inside Move (table::borrow) — treat as "none".
  if (res.error) return null;
  const ret = res.results?.at(-1)?.returnValues;
  if (!ret || ret.length < 6) return null;

  const u64 = (i: number) => Number(bcs.u64().parse(Uint8Array.from(ret[i]![0])));
  return {
    probUpBps: u64(0),
    confidenceBps: u64(1),
    disagreementBps: u64(2),
    marketProbUpBps: u64(3),
    expiryMs: u64(4),
    publishedAtMs: u64(5),
  };
}
