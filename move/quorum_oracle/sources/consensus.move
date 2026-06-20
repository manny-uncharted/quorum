/// Quorum Consensus Oracle — the first on-chain "wisdom of agents" probability
/// feed for DeepBook Predict markets on Sui.
///
/// The Quorum desk runs a multi-agent debate (volatility / momentum / catalyst /
/// flow analysts → bull/bear → trader synthesis) and a deterministic quant core,
/// producing a single calibrated probability that a market finishes ABOVE its
/// strike. This module publishes that consensus on-chain as a *reusable
/// primitive*: any other protocol — option vaults, liquidation engines, other
/// traders — can read the latest consensus P(up), the desk's confidence, and an
/// analyst-disagreement index, each anchored to a Predict oracle and backed by a
/// content-hash of the signed evidence bundle that produced it.
///
/// Probabilities are stored in basis points (0..=10_000) so consumers never deal
/// with floats. Writes are gated by a `PublisherCap`; reads are open to everyone.
module quorum_oracle::consensus;

use std::string::String;
use sui::clock::{Self, Clock};
use sui::event;
use sui::table::{Self, Table};

/// Basis-point denominator: 10_000 bps == 1.0 probability.
const BPS_DENOM: u64 = 10_000;

/// The supplied cap does not authorise this oracle.
const ENotAuthorized: u64 = 0;
/// A probability/confidence/disagreement value exceeded 10_000 bps.
const EBadBps: u64 = 1;

/// One published consensus reading for a single Predict market (oracle).
public struct Reading has store, copy, drop {
    /// The Predict oracle this reading is about.
    oracle_id: ID,
    /// Underlying asset symbol (e.g. "BTC").
    asset: String,
    /// Consensus real-world P(up) in basis points (0..=10_000).
    prob_up_bps: u64,
    /// Desk confidence in the estimate, basis points.
    confidence_bps: u64,
    /// Analyst disagreement index, basis points (0 = unanimous, high = split).
    disagreement_bps: u64,
    /// Market-implied P(up) at publish time, basis points.
    market_prob_up_bps: u64,
    /// Market expiry (epoch milliseconds).
    expiry_ms: u64,
    /// SHA-256 of the signed evidence bundle behind this reading.
    evidence_hash: vector<u8>,
    /// Desk run id (uuid) for cross-referencing the off-chain bundle.
    run_id: String,
    /// Publish timestamp (epoch ms, from the shared Clock).
    published_at_ms: u64,
}

/// Shared registry holding the latest consensus reading per Predict oracle.
public struct ConsensusOracle has key {
    id: UID,
    /// The desk address that created this oracle.
    publisher: address,
    /// oracle_id (Predict) -> latest Reading.
    readings: Table<ID, Reading>,
    /// Number of distinct markets with at least one reading.
    count: u64,
}

/// Capability authorising publication to a specific `ConsensusOracle`.
public struct PublisherCap has key, store {
    id: UID,
    oracle: ID,
}

/// Emitted on every publish so off-chain indexers/consumers can subscribe.
public struct ConsensusPublished has copy, drop {
    oracle: ID,
    reading: Reading,
}

/// Create the shared oracle and hand the publisher cap to the deployer.
fun init(ctx: &mut TxContext) {
    let oracle = ConsensusOracle {
        id: object::new(ctx),
        publisher: ctx.sender(),
        readings: table::new(ctx),
        count: 0,
    };
    let cap = PublisherCap { id: object::new(ctx), oracle: object::id(&oracle) };
    transfer::transfer(cap, ctx.sender());
    transfer::share_object(oracle);
}

/// Publish (upsert) the consensus reading for `oracle_id`. Cap-gated.
public entry fun publish(
    oracle: &mut ConsensusOracle,
    cap: &PublisherCap,
    oracle_id: ID,
    asset: String,
    prob_up_bps: u64,
    confidence_bps: u64,
    disagreement_bps: u64,
    market_prob_up_bps: u64,
    expiry_ms: u64,
    evidence_hash: vector<u8>,
    run_id: String,
    clock: &Clock,
) {
    assert!(cap.oracle == object::id(oracle), ENotAuthorized);
    assert!(prob_up_bps <= BPS_DENOM, EBadBps);
    assert!(confidence_bps <= BPS_DENOM, EBadBps);
    assert!(disagreement_bps <= BPS_DENOM, EBadBps);
    assert!(market_prob_up_bps <= BPS_DENOM, EBadBps);

    let reading = Reading {
        oracle_id,
        asset,
        prob_up_bps,
        confidence_bps,
        disagreement_bps,
        market_prob_up_bps,
        expiry_ms,
        evidence_hash,
        run_id,
        published_at_ms: clock::timestamp_ms(clock),
    };

    // `reading` is copyable: the event carries a copy, the table keeps one.
    event::emit(ConsensusPublished { oracle: object::id(oracle), reading });

    if (oracle.readings.contains(oracle_id)) {
        *oracle.readings.borrow_mut(oracle_id) = reading;
    } else {
        oracle.readings.add(oracle_id, reading);
        oracle.count = oracle.count + 1;
    };
}

// --- Reads (open to all consumers) ---------------------------------------

/// True if a reading exists for `oracle_id`.
public fun has_reading(oracle: &ConsensusOracle, oracle_id: ID): bool {
    oracle.readings.contains(oracle_id)
}

/// Borrow the latest reading for a Predict oracle. Aborts if none exists.
public fun latest(oracle: &ConsensusOracle, oracle_id: ID): &Reading {
    oracle.readings.borrow(oracle_id)
}

/// Consumer-friendly scalar read: the six headline values for `oracle_id`.
/// Returns (prob_up_bps, confidence_bps, disagreement_bps, market_prob_up_bps,
/// expiry_ms, published_at_ms). Aborts if no reading exists.
public fun read(
    oracle: &ConsensusOracle,
    oracle_id: ID,
): (u64, u64, u64, u64, u64, u64) {
    let r = oracle.readings.borrow(oracle_id);
    (
        r.prob_up_bps,
        r.confidence_bps,
        r.disagreement_bps,
        r.market_prob_up_bps,
        r.expiry_ms,
        r.published_at_ms,
    )
}

public fun count(oracle: &ConsensusOracle): u64 { oracle.count }

public fun publisher(oracle: &ConsensusOracle): address { oracle.publisher }

// --- Reading field accessors (for on-chain consumers) --------------------

public fun oracle_id(r: &Reading): ID { r.oracle_id }

public fun asset(r: &Reading): String { r.asset }

public fun prob_up_bps(r: &Reading): u64 { r.prob_up_bps }

public fun confidence_bps(r: &Reading): u64 { r.confidence_bps }

public fun disagreement_bps(r: &Reading): u64 { r.disagreement_bps }

public fun market_prob_up_bps(r: &Reading): u64 { r.market_prob_up_bps }

public fun expiry_ms(r: &Reading): u64 { r.expiry_ms }

public fun evidence_hash(r: &Reading): vector<u8> { r.evidence_hash }

public fun published_at_ms(r: &Reading): u64 { r.published_at_ms }
