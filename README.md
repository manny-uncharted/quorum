# Quorum — an autonomous multi-agent prediction desk on DeepBook Predict

> Sui Overflow 2026 · DeepBook track. A team of AI agents debate a market, reach
> **quorum**, and trade oracle-driven binary options on **DeepBook Predict** — with
> every decision streamed live and recorded as a verifiable on-chain evidence bundle.

---

## Why this, why now

DeepBook **Predict** (the third DeepBook primitive, testnet live since May 2026) lets
anyone mint/redeem binary positions against oracle-driven prices. It is brand new, so
the field of polished apps on top of it is essentially empty — the strategic lane for
this hackathon.

We are not building a raw SDK demo. We are building a *product*: a transparent,
auditable AI trading desk where you can watch the reasoning, see the policy gates, and
verify on-chain why every position was opened.

It pairs a first-principles multi-agent runtime with **all-new** DeepBook Predict
integration, an on-chain consensus-oracle primitive, and the prediction-market product
surface — built during the hackathon window.

## What the judges score (and how we win it)

| Criterion | Weight | Our play |
|-----------|--------|----------|
| Real-world application | 50% | Transparent, auditable AI prediction trading — a real product shape — plus a reusable consensus-probability primitive other protocols can compose with |
| Product & UX | 20% | Live generative-UI desk: watch the debate, odds, positions, P&L, and the on-chain consensus publish |
| Technical implementation | 20% | Real testnet mint/redeem via `@mysten/sui`; policy gates; evidence bundles; our own `quorum_oracle` Move package (cap-gated publish, keyless read, event) |
| Presentation & vision | 10% | Tight ≤5-min demo: problem → live trade → why Sui → roadmap |

---

## Architecture (first principles)

```
  Market Feed  ·  predict-server /oracles
     │   active oracles: asset · expiry · strike · tick · oracle_id
     ▼
  Agent Quorum  ·  multi-agent reasoning runtime
     │   analysts → bull/bear debate → trader proposes YES/NO + size
     │   → quant core (edge, fractional Kelly) → risk gate (ceilings, exposure, daily-loss)
     ▼
  PredictExecutionProvider
     │   preview get_trade_amounts → mint<DUSDC>(predict, manager, oracle, MarketKey, qty,
     │   clock) → ExecutionEnvelope (txDigest, evidence)
     ▼
  quorum_oracle::consensus  ·  on-chain primitive
     │   publish(P(up), confidence, disagreement, evidence hash) + ConsensusPublished event
     │   keyless read() for any downstream protocol
     ▼
  Desk UI  ·  event-sourced generative UI (Bun.serve / SSE)
         live debate · odds · positions · P&L · on-chain publish · evidence panel
```

**The single seam.** Execution is one typed boundary — an `ExecutionProvider`
(`supports` / `execute → ExecutionEnvelope`). The brain doesn't know it's trading
prediction markets; we just add a new provider. The paper provider stays as a fallback so
a demo can never hard-fail.

---

## On-chain facts (DeepBook Predict testnet — verified)

| Thing | Value |
|-------|-------|
| Network | Sui **testnet** |
| Predict package | `0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138` |
| Predict object | `0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a` |
| Predict registry | `0x43af14fed5480c20ff77e2263d5f794c35b9fab7e2212903127062f4fe2a6e64` |
| Quote asset | DUSDC `0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC` (6 dp) |
| PLP (LP token) | `0xf5ea…138::plp::PLP` |
| Server / feed | `https://predict-server.testnet.mystenlabs.com` (`GET /oracles`) |
| Source branch | `predict-testnet-4-16` |

Key Move entry points (package `predict` module):

```move
public fun create_manager(ctx): ID                     // shares a PredictManager
public fun deposit<T>(manager, coin, ctx)              // fund the manager
public fun get_trade_amounts(predict, oracle, key: MarketKey, qty, clock): (u64, u64)  // preview
public fun mint<Quote>(predict, manager, oracle, key: MarketKey, qty, clock, ctx)
public fun redeem<Quote>(predict, manager, oracle, key: MarketKey, qty, clock, ctx)
public fun supply<Quote>(predict, coin, clock, ctx): Coin<PLP>   // LP
```

`Clock` is the shared object at `0x6`. `MarketKey` is built from
`(oracle, strike, direction)` — see `src/predict/market.ts` (resolved against
`market_key.move`).

---

## The trader's brain — rebuilt from first principles

A generic trading loop is an *equity* engine (Buy/Hold/Sell, price targets, multi-month
horizons). A binary option is a different animal, so the desk reasons differently:

**A binary's price IS a probability.** The contract prices off the oracle's SVI
volatility surface — a fair, **driftless** (risk-neutral) baseline. Re-deriving that
baseline yields *no edge*; it equals the market quote by construction. Edge exists only
where the **real-world** probability differs from the driftless one — momentum, order
flow, funding, scheduled catalysts — things risk-neutral pricing ignores over a
15-minute-to-few-hour window.

```
edge = P_subjective(up) − P_implied(market)
```

**Division of labour (deliberate):** the LLM agents estimate a *probability* and argue
about it; the deterministic quant core owns *all arithmetic* — edge, Kelly, sizing,
thresholds. Models are weak at arithmetic and strong at judgement, so a model never
computes a position size.

Pipeline:

```
4 analysts (rebuilt for binaries):
  volatility/pricing · momentum/microstructure · catalyst/news · flow/derivatives
        │  each emits an AnalystSignal {lean, strength, confidence}
        ▼
bull vs bear debate  (is real P(up) > or < the implied price?)
        ▼
trader → BinaryProposal { subjectiveProbUp, confidence, abstain, reasoning }
        ▼
quant.decide()  → edge vs market, ¼-Kelly stake, edge threshold, abstain
        ▼
planner          → sized BinaryTradePlan (stake$ → quantity)
        ▼
risk officer     → circuit breakers (time-to-expiry, vol spike, catalyst, caps)
        ▼
PredictExecutionProvider → real on-chain quote + mint (paper | testnet)
```

This is the differentiator vs a black-box quant market-maker: every trade exposes its
probability estimate, its edge, the debate that produced it, and an on-chain evidence
trail — and it *abstains* when there's no edge (the common case).

### Three personas, one pipeline

The "brain" is a pluggable `SignalSource`; everything after it (planner → risk gate →
executor) is identical. Risk is **code-owned** (`risk.ts` circuit breakers), never a prompt.

| Persona | Command | Brain | Keys |
|---------|---------|-------|------|
| **Beginner** | `bun run desk` | deterministic heuristic | none — keyless paper |
| **Analyst** | `bun run desk --signals manual --prob 0.62` | your own probability | none |
| **Experienced trader** | `bun run desk --signals llm` | 4-analyst + debate (Gemini) | `GEMINI_API_KEY` |

Paper mode prices every order with a **real on-chain quote** (devInspect) but books a
synthetic fill — faithful, fundless. `--mode testnet` submits a real mint.

### Live data, config, multi-asset

- **Live data** (`desk/marketdata.ts`, keyless): Coinbase 1m candles → momentum / RSI /
  realized-vol; Binance funding (best-effort); alternative.me Fear & Greed. Fed to both
  the heuristic and the Gemini analysts; sources degrade to `null` with a note, never break a run.
- **Config-driven** (`desk/config.ts`): bankroll, risk limits, portfolio breakers, Kelly
  fraction, asset list, and Gemini model load from `quorum.config.json` + `QUORUM_*` env
  vars (CLI flags win). Nothing in the trading path is hardcoded.
- **Multi-asset**: the engine is asset-general (`--asset`, symbol map for BTC/ETH/SOL/SUI).
  DeepBook's testnet currently lists **BTC oracles only**, so that's what trades today; no
  code change is needed when more assets appear.

### Live web desk (SSE)

`bun run serve` → `http://localhost:8787`. Press “Run desk” and the analyst signals, debate,
proposal, sized plan, risk verdict, and execution stream in live over Server-Sent Events —
the same typed events the CLI emits — with a portfolio/P&L panel. It's a window into the real
pipeline, not a mock.

### Day-2 status: engine verified end-to-end ✅

`bun run desk` runs the whole pipeline against a **live** testnet market with no funds,
keys, or LLM: reads the SVI surface, computes the risk-neutral baseline, pulls the
market-implied probability from a real quote, runs stubbed subjective views through the
quant decision + sizing, and books paper fills. Risk-neutral P(up) lands at ~50% and
market-implied ~51% (the ~1% gap is the spread). `bun test` covers the quant core
(surface math, digital pricing, Kelly, edge/abstain logic) — 8/8 green.

Layout (new in Day 2):

```
src/desk/
  quant.ts        SVI surface math, digital-option P(up), Kelly, edge, decide()  [+tests]
  oracle.ts*      reads forward/spot + SVI params off the OracleSVI object  (*in predict/)
  types.ts        binary-option domain model (MarketContext, BinaryTradePlan)
  schemas.ts      agent structured outputs (AnalystSignal, BinaryProposal, RiskVerdict)
  instructions.ts first-principles prompts for the 4 analysts, debate, trader, risk
  planner.ts      live MarketContext + stake→quantity sizing
  executor.ts     PredictExecutionProvider (paper uses real quotes; testnet mints)
src/fabric/       desk runtime kernel (agent loop, policy, memory, evidence primitives)
```

## Build plan (4 days → June 21, 6PM PT)

- **Day 1 (de-risk):** market feed + chain client + standalone spike: create manager →
  deposit DUSDC → preview → mint ONE binary position on testnet. ← *we are here*
- **Day 2:** `PredictExecutionProvider` behind the desk's `ExecutionProvider` seam;
  agent debate → risk gate → real mint. Paper fallback retained.
- **Day 3:** generative-UI desk (SSE) + redeem/settlement + evidence panel.
- **Day 4:** polish, deploy, README, ≤5-min demo video, submit.

## Deploy

For the demo, run locally: `bun run serve` → `http://localhost:8787`.

As a service (container): the desk UI is a `Bun.serve` app.

```bash
docker build -f quorum/Dockerfile -t quorum .
docker run -p 8787:8787 --env-file quorum/.env quorum
```

Provide `GEMINI_API_KEY` for the LLM brain; the heuristic and manual brains need no keys.
On Railway/Render/Fly, set the start command to `bun run src/scripts/serve.ts`.

Submission artifacts: `SUBMISSION.md` (checklist), `VIDEO.md` / `DEMO_SCRIPT.md`
(demo script), `web/index.html` (landing page), `assets/logo.png` (1:1).

## Run

```bash
bun install
bun run markets               # read-only: list active Predict markets   (no keys/funds)
bun run preview               # on-chain pricing via devInspect           (no keys/funds)
bun test                      # quant core unit tests                     (no keys/funds)

# The end-to-end desk, by persona:
bun run desk                              # Beginner: keyless heuristic, paper trading
bun run desk --signals manual --prob 0.62 # Analyst: bring your own P(up); desk sizes+executes
bun run desk --signals llm                # Experienced trader: full Gemini agent debate (needs GEMINI_API_KEY)
bun run desk --mode testnet               # execute a REAL mint (needs SUI gas + DUSDC + PREDICT_MANAGER_ID)

bun run settle                            # close out settled positions, book P&L (--simulate-price to demo)
bun run loop --interval 120 --count 3     # continuous: settle + scan top markets every 2 min
bun run serve                             # live web desk (SSE) at http://localhost:8787

# Asset filter + config:
bun run desk --asset BTC                  # restrict to an asset (DeepBook testnet lists BTC only)
#   limits/bankroll/model are config-driven: quorum.config.json + QUORUM_* env vars

cp .env.example .env          # add SUI_PRIVATE_KEY (testnet) for --mode testnet; GEMINI_API_KEY for --signals llm
bun run spike                 # create manager → deposit → preview → mint (needs testnet funds)

# Consensus Oracle — the on-chain primitive (needs SUI key + a deployed quorum_oracle):
bun run oracle publish        # run the desk on a market and publish its consensus on-chain (no DUSDC)
bun run oracle read <oracleId>      # keyless consumer read of the latest consensus
bun run oracle consumer <oracleId>  # demo: an option vault sizes an allocation from the feed
```

`markets` and `preview` are **proven working against testnet** — they need no wallet.
`spike` additionally needs testnet SUI (gas) + DUSDC in that account.

## Consensus Oracle — the on-chain primitive

Quorum doesn't just *consume* DeepBook Predict — it **emits a new primitive**. Each run
publishes its consensus to a shared `ConsensusOracle` object (`move/quorum_oracle`):
real-world `P(up)`, confidence, an **analyst-disagreement index**, the market-implied
probability, expiry, and the SHA-256 of the signed evidence bundle — all in basis points.
Writes are gated by a `PublisherCap`; reads are open to all via a keyless `consensus::read`
view, and every publish emits a `ConsensusPublished` event for indexers.

Sui has no forward-looking, reasoning-derived probability benchmark today; this is one — a
transparent "wisdom of agents" feed any protocol can read (option vaults to price/skew,
liquidation engines, other desks). `bun run oracle consumer <oracleId>` ships a working
downstream consumer that sizes a vault tilt from the feed, discounted by disagreement.
Publishing needs only the desk key (no DUSDC), so the primitive works in the keyless demo too.

```bash
# Deploy once, then wire the three ids into .env:
sui client publish move/quorum_oracle      # → QUORUM_ORACLE_PACKAGE (package),
                                           #   QUORUM_ORACLE_OBJECT (shared ConsensusOracle),
                                           #   QUORUM_ORACLE_CAP (PublisherCap, owned by the desk key)
```

### Day-1 status: de-risk complete ✅

The whole DeepBook Predict read/price path is verified live on testnet with zero
funds: market feed (`/oracles`), `MarketKey` construction, oracle forward-price
lookup, and `get_trade_amounts` pricing via `devInspect`. Example: an ATM BTC UP
contract prices at ~0.51 DUSDC / 1M units (≈51% implied probability). The mint/redeem
builders are written and typed; the only thing gating a real on-chain mint is funding
the signer.

### Get testnet funds (to run `spike`)

1. Generate a key: `bunx @mysten/sui keytool generate ed25519`, put the
   `suiprivkey1…` into `.env` as `SUI_PRIVATE_KEY`.
2. Gas: testnet SUI faucet — https://faucet.sui.io (or `bunx @mysten/sui faucet`).
3. DUSDC: request via the DeepBook Predict testnet token form (quote currency
   `0xf3000dff421833d4bb8ed58fac146d691a3aaba2785aa1989af65a7089ca3e9c`).
