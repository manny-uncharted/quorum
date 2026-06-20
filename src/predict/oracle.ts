/**
 * Reads live pricing off an `OracleSVI` object.
 *
 * Predict markets price relative to the oracle's forward/spot. Strikes that sit
 * far from the forward have no defined quote (the contract aborts in
 * `pricing_config`), so trade builders must choose strikes near the forward and
 * on the tick grid. This module supplies the forward/spot and the snapping helper.
 */

import { client } from "../chain/client.js";
import type { Svi } from "../desk/quant.js";
import { STRIKE_SCALE } from "./types.js";

/** SVI params are stored as fixed-point at the same 1e9 scale as prices. */
const SVI_SCALE = 1e9;

export interface OraclePrices {
  /** Forward price in raw on-chain units (same scale as strike). */
  forwardRaw: bigint;
  spotRaw: bigint;
  /** Human-scaled forward/spot. */
  forward: number;
  spot: number;
}

/** Forward/spot plus the parsed SVI volatility surface for one oracle. */
export interface OracleSurface extends OraclePrices {
  svi: Svi;
}

/** Parse a Move `I64 { is_negative, magnitude }` field to a signed number. */
function parseI64(field: unknown, scale: number): number {
  const f = (field as { fields?: { is_negative?: boolean; magnitude?: string } })
    ?.fields;
  if (f?.magnitude == null) throw new Error("malformed I64 field");
  const mag = Number(f.magnitude) / scale;
  return f.is_negative ? -mag : mag;
}

async function readOracleFields(
  oracleId: string,
): Promise<Record<string, unknown>> {
  const obj = await client.getObject({
    id: oracleId,
    options: { showContent: true },
  });
  const content = obj.data?.content;
  if (!content || content.dataType !== "moveObject") {
    throw new Error(`Oracle ${oracleId} has no readable content`);
  }
  return content.fields as Record<string, unknown>;
}

function pricesFrom(fields: Record<string, unknown>): OraclePrices {
  const prices = (fields.prices as { fields?: Record<string, string> })?.fields;
  if (!prices?.forward || !prices?.spot) {
    throw new Error("Oracle missing price data");
  }
  const forwardRaw = BigInt(prices.forward);
  const spotRaw = BigInt(prices.spot);
  return {
    forwardRaw,
    spotRaw,
    forward: Number(forwardRaw) / STRIKE_SCALE,
    spot: Number(spotRaw) / STRIKE_SCALE,
  };
}

export async function fetchOraclePrices(oracleId: string): Promise<OraclePrices> {
  return pricesFrom(await readOracleFields(oracleId));
}

/** Read forward/spot AND the SVI volatility surface in a single object fetch. */
export async function fetchOracleSurface(
  oracleId: string,
): Promise<OracleSurface> {
  const fields = await readOracleFields(oracleId);
  const prices = pricesFrom(fields);
  const svi = (fields.svi as { fields?: Record<string, unknown> })?.fields;
  if (!svi) throw new Error(`Oracle ${oracleId} missing SVI params`);
  return {
    ...prices,
    svi: {
      a: Number(svi.a) / SVI_SCALE,
      b: Number(svi.b) / SVI_SCALE,
      sigma: Number(svi.sigma) / SVI_SCALE,
      m: parseI64(svi.m, SVI_SCALE),
      rho: parseI64(svi.rho, SVI_SCALE),
    },
  };
}

/** Snap a raw price to the market's tick grid. */
export function snapToTick(priceRaw: bigint, tickRaw: bigint): bigint {
  if (tickRaw <= 0n) return priceRaw;
  return (priceRaw / tickRaw) * tickRaw;
}

/**
 * Pick an at-the-money-ish strike for a direction, offset by `ticks` from the
 * forward (positive = further OTM). Returns a strike on the tick grid.
 */
export function strikeNearForward(
  forwardRaw: bigint,
  tickRaw: bigint,
  ticks = 0,
): bigint {
  const base = snapToTick(forwardRaw, tickRaw);
  return base + BigInt(ticks) * tickRaw;
}
