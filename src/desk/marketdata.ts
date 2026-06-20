/**
 * Live market-data pack — real, keyless signals for the analysts.
 *
 * The DeepBook oracle is the settlement source; this module supplies the
 * *directional* context risk-neutral pricing ignores: recent price action and
 * momentum (Coinbase candles), derivatives positioning (Binance funding,
 * best-effort), and crowd sentiment (alternative.me Fear & Greed). All public,
 * no API keys. Every source is wrapped so a failure degrades to `null` with a
 * note rather than breaking the run — the analysts are told to handle gaps.
 *
 * Note: on testnet the oracle's underlying is synthetic, so the level can differ
 * from spot; the *dynamics* (momentum, vol regime, funding, sentiment) remain a
 * legitimate directional proxy, and on mainnet the oracle tracks the real asset.
 */

/** Map an oracle asset symbol to venue product ids. */
const PRODUCTS: Record<string, { coinbase: string; binance: string }> = {
  BTC: { coinbase: "BTC-USD", binance: "BTCUSDT" },
  ETH: { coinbase: "ETH-USD", binance: "ETHUSDT" },
  SOL: { coinbase: "SOL-USD", binance: "SOLUSDT" },
  SUI: { coinbase: "SUI-USD", binance: "SUIUSDT" },
};

export interface MarketData {
  asset: string;
  spotUsd: number | null;
  /** % return over the trailing window. */
  ret15mPct: number | null;
  ret1hPct: number | null;
  /** Wilder RSI(14) on 1-minute closes. */
  rsi14: number | null;
  /** Annualized realized vol from 1-minute log returns, %. */
  realizedVolPct: number | null;
  /** Last perp funding rate, % (positive = longs pay shorts). */
  fundingRatePct: number | null;
  fearGreed: number | null;
  fearGreedLabel: string | null;
  notes: string[];
}

async function getJson(url: string, ms = 8000): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

function rsi14(closes: number[]): number | null {
  if (closes.length < 15) return null;
  let gain = 0;
  let loss = 0;
  for (let i = closes.length - 14; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    if (d >= 0) gain += d;
    else loss -= d;
  }
  const avgG = gain / 14;
  const avgL = loss / 14;
  if (avgL === 0) return 100;
  const rs = avgG / avgL;
  return 100 - 100 / (1 + rs);
}

function realizedVolPct(closes: number[]): number | null {
  if (closes.length < 10) return null;
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i]! / closes[i - 1]!));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
  // 1-minute returns → annualize with sqrt(525600 minutes/year).
  return Math.sqrt(variance) * Math.sqrt(525_600) * 100;
}

/** Fetch the full data pack for an asset; never throws. */
export async function fetchMarketData(asset: string): Promise<MarketData> {
  const notes: string[] = [];
  const prod = PRODUCTS[asset.toUpperCase()];
  const data: MarketData = {
    asset,
    spotUsd: null,
    ret15mPct: null,
    ret1hPct: null,
    rsi14: null,
    realizedVolPct: null,
    fundingRatePct: null,
    fearGreed: null,
    fearGreedLabel: null,
    notes,
  };
  if (!prod) {
    notes.push(`no market-data product mapping for ${asset}`);
    return data;
  }

  // Coinbase 1m candles (newest first): [time, low, high, open, close, volume].
  try {
    const raw = (await getJson(
      `https://api.exchange.coinbase.com/products/${prod.coinbase}/candles?granularity=60`,
    )) as number[][];
    const closesNewestFirst = raw.map((c) => c[4]!);
    const closes = closesNewestFirst.slice().reverse(); // oldest → newest
    const n = closes.length;
    if (n > 0) {
      data.spotUsd = closes[n - 1]!;
      if (n > 15) data.ret15mPct = (closes[n - 1]! / closes[n - 16]! - 1) * 100;
      if (n > 60) data.ret1hPct = (closes[n - 1]! / closes[n - 61]! - 1) * 100;
      data.rsi14 = rsi14(closes);
      data.realizedVolPct = realizedVolPct(closes.slice(-60));
    }
  } catch (e) {
    notes.push(`price/candles unavailable (${String(e).slice(0, 60)})`);
  }

  // Binance perp funding (best-effort; may be geo-blocked).
  try {
    const pi = (await getJson(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${prod.binance}`)) as {
      lastFundingRate?: string;
    };
    if (pi.lastFundingRate != null) data.fundingRatePct = Number(pi.lastFundingRate) * 100;
  } catch {
    notes.push("funding rate unavailable");
  }

  // Fear & Greed (crypto-wide sentiment).
  try {
    const fg = (await getJson("https://api.alternative.me/fng/")) as {
      data?: Array<{ value: string; value_classification: string }>;
    };
    const row = fg.data?.[0];
    if (row) {
      data.fearGreed = Number(row.value);
      data.fearGreedLabel = row.value_classification;
    }
  } catch {
    notes.push("fear & greed unavailable");
  }

  return data;
}

/** Compact human/LLM-readable summary for prompts and logs. */
export function summarizeMarketData(d: MarketData): string {
  const p = (v: number | null, suffix = "") => (v == null ? "n/a" : `${v.toFixed(2)}${suffix}`);
  return [
    `spot ${d.spotUsd == null ? "n/a" : d.spotUsd.toLocaleString()}`,
    `ret15m ${p(d.ret15mPct, "%")}`,
    `ret1h ${p(d.ret1hPct, "%")}`,
    `RSI14 ${p(d.rsi14)}`,
    `realizedVol ${p(d.realizedVolPct, "%")}`,
    `funding ${p(d.fundingRatePct, "%")}`,
    `fear&greed ${d.fearGreed ?? "n/a"}${d.fearGreedLabel ? ` (${d.fearGreedLabel})` : ""}`,
  ].join(" · ") + (d.notes.length ? `  [${d.notes.join("; ")}]` : "");
}
