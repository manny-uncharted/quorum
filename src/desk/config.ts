/**
 * Desk configuration — file + env driven, validated, with sane defaults.
 *
 * Resolution order (last wins): built-in defaults → `quorum.config.json`
 * (if present in cwd or QUORUM_CONFIG path) → environment overrides. CLI flags
 * (handled by the runners) override everything. Nothing is hardcoded in the
 * trading path — limits, bankroll, assets, and the model all live here.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { z } from "zod";

import { DEFAULT_RISK_LIMITS } from "./risk.js";
import { DEFAULT_PORTFOLIO_LIMITS } from "./portfolio.js";

export const DeskConfigSchema = z.object({
  bankrollUsd: z.number().positive(),
  signals: z.enum(["heuristic", "manual", "llm"]),
  /** Restrict trading to these assets; null = whatever the venue lists. */
  assets: z.array(z.string()).nullable(),
  kellyFractionCap: z.number().min(0).max(1),
  risk: z.object({
    minMinsToExpiry: z.number().nonnegative(),
    maxMinsToExpiry: z.number().positive(),
    maxStakeFraction: z.number().min(0).max(1),
    maxAnnualizedVol: z.number().positive(),
    minEdge: z.number().min(0).max(1),
    slippageToleranceBps: z.number().int().nonnegative(),
  }),
  portfolio: z.object({
    maxConcurrentPositions: z.number().int().positive(),
    maxOpenExposureUsd: z.number().positive(),
    dailyLossLimitUsd: z.number().positive(),
  }),
  gemini: z.object({
    model: z.string(),
    maxTokens: z.number().int().positive(),
  }),
});

export type DeskConfig = z.infer<typeof DeskConfigSchema>;

export const DEFAULT_CONFIG: DeskConfig = {
  bankrollUsd: 1000,
  signals: "heuristic",
  assets: null,
  kellyFractionCap: 0.25,
  risk: { ...DEFAULT_RISK_LIMITS },
  portfolio: { ...DEFAULT_PORTFOLIO_LIMITS },
  gemini: { model: "gemini-3.5-flash", maxTokens: 8192 },
};

function deepMerge<T>(base: T, over: unknown): T {
  if (over == null || typeof over !== "object" || Array.isArray(over)) return (over as T) ?? base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    const cur = (base as Record<string, unknown>)[k];
    out[k] = v && typeof v === "object" && !Array.isArray(v) ? deepMerge(cur, v) : v;
  }
  return out as T;
}

function envOverrides(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  const num = (v?: string) => (v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);
  if (num(env.QUORUM_BANKROLL) !== undefined) o.bankrollUsd = num(env.QUORUM_BANKROLL);
  if (env.QUORUM_SIGNALS) o.signals = env.QUORUM_SIGNALS;
  if (env.QUORUM_ASSETS) o.assets = env.QUORUM_ASSETS.split(",").map((s) => s.trim().toUpperCase());
  const risk: Record<string, unknown> = {};
  if (num(env.QUORUM_MIN_EDGE) !== undefined) risk.minEdge = num(env.QUORUM_MIN_EDGE);
  if (num(env.QUORUM_MAX_STAKE_FRACTION) !== undefined) risk.maxStakeFraction = num(env.QUORUM_MAX_STAKE_FRACTION);
  if (num(env.QUORUM_SLIPPAGE_BPS) !== undefined) risk.slippageToleranceBps = num(env.QUORUM_SLIPPAGE_BPS);
  if (Object.keys(risk).length) o.risk = risk;
  const pf: Record<string, unknown> = {};
  if (num(env.QUORUM_MAX_CONCURRENT) !== undefined) pf.maxConcurrentPositions = num(env.QUORUM_MAX_CONCURRENT);
  if (num(env.QUORUM_DAILY_LOSS_LIMIT) !== undefined) pf.dailyLossLimitUsd = num(env.QUORUM_DAILY_LOSS_LIMIT);
  if (Object.keys(pf).length) o.portfolio = pf;
  if (env.GEMINI_MODEL) o.gemini = { model: env.GEMINI_MODEL };
  return o;
}

/** Load and validate the effective desk config. */
export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<DeskConfig> {
  let merged: DeskConfig = DEFAULT_CONFIG;
  const file = env.QUORUM_CONFIG ?? path.resolve("quorum.config.json");
  try {
    const fromFile = JSON.parse(await fs.readFile(file, "utf8"));
    merged = deepMerge(merged, fromFile);
  } catch {
    // no config file — defaults are fine
  }
  merged = deepMerge(merged, envOverrides(env));
  return DeskConfigSchema.parse(merged);
}
