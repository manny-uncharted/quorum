/**
 * DeepBook Predict execution provider.
 *
 * Mirrors the vendored fabric `ExecutionProvider` contract (`id` / `supports` /
 * `execute → ExecutionEnvelope`) but speaks the binary-option domain. Two modes:
 *
 *   - paper   — prices the order with a REAL on-chain `get_trade_amounts` quote
 *               (devInspect, no funds, no signing) and books a synthetic fill.
 *               Faithful enough to demo and eval without a funded wallet.
 *   - testnet — funds the manager and submits a real `mint` PTB.
 *
 * Either way it returns the fabric `ExecutionEnvelope`, so the audit log, replay,
 * and UI consume one shape regardless of surface.
 */

import { randomUUID } from "node:crypto";

import { Transaction } from "@mysten/sui/transactions";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

import { client } from "../chain/client.js";
import type { ExecutionEnvelope } from "../fabric/types/index.js";
import {
  addDeposit,
  addMint,
  fromDusdcRaw,
  previewTrade,
  toDusdcRaw,
  type TradeIntent,
} from "../predict/market.js";
import type { BinaryTradePlan, ExecContext } from "./types.js";

export type ExecutionMode = "paper" | "testnet";

export interface PredictExecutorOptions {
  mode: ExecutionMode;
  /** Required for testnet mode. */
  keypair?: Ed25519Keypair;
  /** Funded, shared PredictManager id — required for testnet mode. */
  managerId?: string;
  /** Address used to price devInspect quotes; defaults to the keypair's. */
  quoteSender?: string;
}

const PROVIDER_ID = "deepbook-predict";

function intentOf(plan: BinaryTradePlan): TradeIntent {
  return {
    market: plan.context.market,
    direction: plan.direction,
    strikeRaw: plan.context.strikeRaw,
    quantity: plan.quantity,
  };
}

function tickerOf(plan: BinaryTradePlan): string {
  const { context } = plan;
  return `${context.market.asset}-${context.strike}-${context.market.expiry
    .toISOString()
    .slice(0, 16)}`;
}

export class PredictExecutionProvider {
  readonly id = PROVIDER_ID;
  private readonly mode: ExecutionMode;
  private readonly keypair?: Ed25519Keypair;
  private readonly managerId?: string;
  private readonly quoteSender: string;

  constructor(opts: PredictExecutorOptions) {
    this.mode = opts.mode;
    this.keypair = opts.keypair;
    this.managerId = opts.managerId;
    const fromKey = opts.keypair?.getPublicKey().toSuiAddress();
    this.quoteSender =
      opts.quoteSender ?? fromKey ?? "0x".padEnd(66, "0"); // dummy for views
    if (this.mode === "testnet" && (!this.keypair || !this.managerId)) {
      throw new Error("testnet mode requires keypair + managerId");
    }
  }

  /** Tradable only while the market is active and unexpired. */
  supports(plan: BinaryTradePlan): boolean {
    return (
      plan.context.market.status === "active" &&
      plan.context.market.msToExpiry > 0 &&
      plan.quantity > 0n
    );
  }

  async execute(
    plan: BinaryTradePlan,
    ctx: ExecContext,
  ): Promise<ExecutionEnvelope> {
    const base = this.baseEnvelope(plan, ctx);
    if (!this.supports(plan)) {
      return {
        ...base,
        surface: "failed",
        status: "rejected",
        error: { code: "UNSUPPORTED", message: "market closed or zero qty" },
      };
    }

    // Real on-chain quote in both modes — the price is never faked.
    let costRaw: bigint;
    try {
      ({ costRaw } = await previewTrade(intentOf(plan), this.quoteSender));
    } catch (err) {
      return {
        ...base,
        surface: "failed",
        status: "rejected",
        error: { code: "QUOTE_FAILED", message: String(err) },
      };
    }
    const amountUsd = fromDusdcRaw(costRaw);

    if (this.mode === "paper") {
      return {
        ...base,
        amountUsd,
        surface: "simulation",
        status: "filled",
        txHash: `paper-${randomUUID().slice(0, 12)}`,
        metadata: { ...base.metadata, costRaw: costRaw.toString() },
      };
    }
    return this.executeTestnet(plan, base, costRaw, amountUsd);
  }

  private async executeTestnet(
    plan: BinaryTradePlan,
    base: ExecutionEnvelope,
    costRaw: bigint,
    amountUsd: number,
  ): Promise<ExecutionEnvelope> {
    const owner = this.keypair!.getPublicKey().toSuiAddress();
    const tx = new Transaction();
    // Fund with a small buffer over the quote, then mint atomically.
    await addDeposit(tx, this.managerId!, owner, costRaw + toDusdcRaw(0.25));
    addMint(tx, this.managerId!, intentOf(plan));

    const res = await client.signAndExecuteTransaction({
      signer: this.keypair!,
      transaction: tx,
      options: { showEffects: true },
    });
    await client.waitForTransaction({ digest: res.digest });
    const ok = res.effects?.status?.status === "success";
    return {
      ...base,
      amountUsd,
      surface: "testnet",
      status: ok ? "filled" : "rejected",
      txHash: res.digest,
      error: ok
        ? null
        : { code: "MINT_FAILED", message: JSON.stringify(res.effects?.status) },
      metadata: {
        ...base.metadata,
        costRaw: costRaw.toString(),
        explorer: `https://suiscan.xyz/testnet/tx/${res.digest}`,
      },
    };
  }

  private baseEnvelope(
    plan: BinaryTradePlan,
    ctx: ExecContext,
  ): ExecutionEnvelope {
    return {
      decisionId: plan.decisionId,
      ticker: tickerOf(plan),
      trade_date: new Date().toISOString().slice(0, 10),
      action: plan.direction === "up" ? "Buy" : "Sell",
      amountUsd: 0,
      txHash: null,
      signedAction: null,
      policyVerdicts: [],
      traceId: ctx.traceId ?? ctx.runId,
      executedAt: new Date().toISOString(),
      surface: "simulation",
      provider: PROVIDER_ID,
      status: "skipped",
      error: null,
      metadata: {
        direction: plan.direction,
        oracleId: plan.context.market.oracleId,
        strike: plan.context.strike,
        strikeRaw: plan.context.strikeRaw.toString(),
        quantity: plan.quantity.toString(),
        edge: plan.edge,
        subjectiveProbUp: plan.subjectiveProbUp,
        marketProbUp: plan.context.marketProbUp,
        riskNeutralProbUp: plan.context.riskNeutralProbUp,
        stakeFraction: plan.stakeFraction,
      },
    };
  }
}
