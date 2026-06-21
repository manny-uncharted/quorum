/**
 * Portfolio — persistent position state, P&L, and portfolio-level risk.
 *
 * File-backed (append-only ledger + materialized positions) so the desk survives
 * restarts and every fill is auditable. Enforces the portfolio-level circuit
 * breakers a single-trade risk gate can't: max concurrent exposure, a daily
 * realized-loss kill switch, and idempotency (never double-open the same market/
 * strike/side). These are the controls a black-box bot quietly omits.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

import type { ExecutionEnvelope } from "../fabric/types/index.js";
import { fromDusdcRaw } from "../predict/market.js";
import type { Direction } from "./quant.js";
import type { BinaryTradePlan } from "./types.js";

export type PositionStatus = "open" | "won" | "lost" | "redeemed" | "void";

export interface Position {
  id: string;
  decisionId: string;
  runId: string;
  oracleId: string;
  asset: string;
  direction: Direction;
  strike: number;
  strikeRaw: string;
  /** Raw contract units. Winning payout ≈ this in DUSDC. */
  quantity: string;
  costUsd: number;
  edge: number;
  subjectiveProbUp: number;
  surface: ExecutionEnvelope["surface"];
  txHash: string | null;
  openedAt: string;
  expiry: string;
  status: PositionStatus;
  settlementPrice?: number;
  realizedPnlUsd?: number;
  settledAt?: string;
}

export interface PortfolioLimits {
  /** Max simultaneously open positions. */
  maxConcurrentPositions: number;
  /** Max total open cost (USD) at risk at once. */
  maxOpenExposureUsd: number;
  /** Halt opening new positions once today's realized loss exceeds this. */
  dailyLossLimitUsd: number;
}

export const DEFAULT_PORTFOLIO_LIMITS: PortfolioLimits = {
  maxConcurrentPositions: 5,
  maxOpenExposureUsd: 250,
  dailyLossLimitUsd: 100,
};

function idemKey(oracleId: string, strikeRaw: string, dir: Direction): string {
  return `${oracleId}:${strikeRaw}:${dir}`;
}

export class Portfolio {
  private positions: Position[] = [];
  private readonly lockFile: string;
  private lockQueue: Promise<void> = Promise.resolve();

  private constructor(
    private readonly file: string,
    private readonly ledger: string,
  ) {
    this.lockFile = path.join(path.dirname(file), "portfolio.lock");
  }

  /** Open (or create) a portfolio rooted at `dataDir`. */
  static async open(dataDir = path.resolve("data")): Promise<Portfolio> {
    await fs.mkdir(dataDir, { recursive: true });
    const p = new Portfolio(
      path.join(dataDir, "positions.json"),
      path.join(dataDir, "ledger.jsonl"),
    );
    const release = await p.lock();
    try {
      await p.reload();
    } finally {
      await release();
    }
    return p;
  }

  async lock(timeoutMs = 15000): Promise<() => Promise<void>> {
    let resolveLock!: (release: () => Promise<void>) => void;
    let rejectLock!: (err: Error) => void;
    const lockAcquired = new Promise<() => Promise<void>>((res, rej) => {
      resolveLock = res;
      rejectLock = rej;
    });

    this.lockQueue = this.lockQueue.then(async () => {
      const start = Date.now();
      let acquired = false;
      while (!acquired) {
        try {
          const handle = await fs.open(this.lockFile, "wx");
          await handle.writeFile(process.pid.toString(), "utf8");
          await handle.close();
          acquired = true;
        } catch (err: any) {
          if (err.code !== "EEXIST") {
            rejectLock(err);
            return;
          }

          // Check if the lockfile is stale (owner process no longer exists)
          try {
            const content = await fs.readFile(this.lockFile, "utf8");
            const pid = parseInt(content.trim(), 10);
            if (Number.isInteger(pid)) {
              try {
                // Signal 0 checks process existence without sending actual signal
                process.kill(pid, 0);
              } catch (e: any) {
                if (e.code === "ESRCH") {
                  // Process is dead, safe to unlink
                  console.log(`[Lock] Found stale lockfile from dead PID ${pid}, unlinking.`);
                  await fs.unlink(this.lockFile);
                  continue; // try to acquire again immediately
                }
              }
            }
          } catch {
            // Ignore error if file doesn't exist anymore or is empty
          }

          if (Date.now() - start > timeoutMs) {
            rejectLock(new Error(`Timeout acquiring lock on ${this.lockFile} after ${timeoutMs}ms`));
            return;
          }
          await new Promise((r) => setTimeout(r, 50));
        }
      }

      let released = false;
      resolveLock(async () => {
        if (released) return;
        released = true;
        try {
          await fs.unlink(this.lockFile);
        } catch {
          // ignore
        }
      });
    }).catch((err) => {
      rejectLock(err);
    });

    return lockAcquired;
  }

  async reload(): Promise<void> {
    try {
      this.positions = JSON.parse(await fs.readFile(this.file, "utf8")) as Position[];
    } catch {
      this.positions = [];
    }
  }

  all(): readonly Position[] {
    return this.positions;
  }
  open_(): Position[] {
    return this.positions.filter((p) => p.status === "open");
  }
  openExposureUsd(): number {
    return this.open_().reduce((s, p) => s + p.costUsd, 0);
  }
  realizedPnlUsd(): number {
    return this.positions.reduce((s, p) => s + (p.realizedPnlUsd ?? 0), 0);
  }
  /** Realized P&L booked on a given UTC date (default today). */
  realizedPnlOn(date = new Date().toISOString().slice(0, 10)): number {
    return this.positions
      .filter((p) => p.settledAt?.slice(0, 10) === date)
      .reduce((s, p) => s + (p.realizedPnlUsd ?? 0), 0);
  }

  /**
   * Portfolio-level pre-trade gate. Returns ok=false with a reason when a
   * breaker trips. Runs BEFORE execution.
   */
  canOpen(
    plan: BinaryTradePlan,
    costUsd: number,
    limits: PortfolioLimits = DEFAULT_PORTFOLIO_LIMITS,
  ): { ok: boolean; reason?: string } {
    const key = idemKey(plan.context.market.oracleId, plan.context.strikeRaw.toString(), plan.direction);
    if (this.open_().some((p) => idemKey(p.oracleId, p.strikeRaw, p.direction) === key)) {
      return { ok: false, reason: "idempotency: an open position already exists on this market/strike/side" };
    }
    if (this.open_().length >= limits.maxConcurrentPositions) {
      return { ok: false, reason: `max concurrent positions (${limits.maxConcurrentPositions}) reached` };
    }
    if (this.openExposureUsd() + costUsd > limits.maxOpenExposureUsd) {
      return { ok: false, reason: `open exposure cap $${limits.maxOpenExposureUsd} would be exceeded` };
    }
    const lossToday = -Math.min(0, this.realizedPnlOn());
    if (lossToday >= limits.dailyLossLimitUsd) {
      return { ok: false, reason: `daily loss limit $${limits.dailyLossLimitUsd} hit (kill switch)` };
    }
    return { ok: true };
  }

  /** Record a filled order as an open position. */
  async record(plan: BinaryTradePlan, env: ExecutionEnvelope): Promise<Position> {
    const pos: Position = {
      id: `${plan.decisionId.slice(0, 8)}-${Date.now()}`,
      decisionId: plan.decisionId,
      runId: env.traceId,
      oracleId: plan.context.market.oracleId,
      asset: plan.context.market.asset,
      direction: plan.direction,
      strike: plan.context.strike,
      strikeRaw: plan.context.strikeRaw.toString(),
      quantity: plan.quantity.toString(),
      costUsd: env.amountUsd,
      edge: plan.edge,
      subjectiveProbUp: plan.subjectiveProbUp,
      surface: env.surface,
      txHash: env.txHash,
      openedAt: env.executedAt,
      expiry: plan.context.market.expiry.toISOString(),
      status: "open",
    };
    this.positions.push(pos);
    await this.persist({ kind: "open", position: pos });
    return pos;
  }

  /**
   * Settle every open position on a settled oracle. Winning UP needs
   * settlement > strike (DOWN the reverse). Winning payout ≈ quantity (DUSDC).
   * Returns the positions that were settled.
   */
  async settleOracle(
    oracleId: string,
    settlementPrice: number,
    at = new Date().toISOString(),
  ): Promise<Position[]> {
    const release = await this.lock();
    try {
      await this.reload();
      const settled: Position[] = [];
      for (const p of this.positions) {
        if (p.oracleId !== oracleId || p.status !== "open") continue;
        const won =
          p.direction === "up" ? settlementPrice > p.strike : settlementPrice < p.strike;
        const payoutUsd = won ? fromDusdcRaw(BigInt(p.quantity)) : 0;
        p.status = won ? "won" : "lost";
        p.settlementPrice = settlementPrice;
        p.realizedPnlUsd = payoutUsd - p.costUsd;
        p.settledAt = at;
        settled.push(p);
        await this.persist({ kind: "settle", position: p });
      }
      if (settled.length) await this.save();
      return settled;
    } finally {
      await release();
    }
  }

  private async persist(entry: { kind: string; position: Position }): Promise<void> {
    await fs.appendFile(
      this.ledger,
      JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n",
      "utf8",
    );
    await this.save();
  }
  private async save(): Promise<void> {
    await fs.writeFile(this.file, JSON.stringify(this.positions, null, 2), "utf8");
  }
}
