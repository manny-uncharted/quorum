/**
 * Evidence bundle — a verifiable, tamper-evident record of one desk decision.
 *
 * Serializes the entire run (context, analyst signals, debate, proposal, sized
 * plan, risk verdict, execution, and the full event log), content-hashes it
 * (SHA-256), and optionally signs the hash with the desk's Sui key. Anyone can
 * re-hash the bundle and verify the signature against the desk's address — the
 * reasoning behind every trade is auditable, not a black box.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

import { toBase64 } from "@mysten/sui/utils";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

import type { DeskRunResult } from "./orchestrator.js";

export interface EvidenceBundle {
  runId: string;
  createdAt: string;
  /** SHA-256 hex of the canonical bundle body. */
  hash: string;
  /** Base64 Ed25519 signature over the hash (present when a signer is given). */
  signature?: string;
  /** Signer's Sui address (verification key). */
  signer?: string;
  body: unknown;
}

/** JSON replacer that renders bigints as decimal strings. */
function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

/** Stable-ish canonical JSON (insertion order + bigint→string). */
export function canonicalize(body: unknown): string {
  return JSON.stringify(body, bigintReplacer);
}

export async function buildEvidence(
  result: DeskRunResult,
  opts: { signer?: Ed25519Keypair } = {},
): Promise<EvidenceBundle> {
  const body = {
    runId: result.runId,
    analysis: result.analysis,
    plan: result.plan,
    verdict: result.verdict,
    execution: result.execution,
    events: result.events,
  };
  const canonical = canonicalize(body);
  const hash = createHash("sha256").update(canonical).digest("hex");

  let signature: string | undefined;
  let signer: string | undefined;
  if (opts.signer) {
    const sig = await opts.signer.sign(new TextEncoder().encode(hash));
    signature = toBase64(sig);
    signer = opts.signer.getPublicKey().toSuiAddress();
  }
  return { runId: result.runId, createdAt: new Date().toISOString(), hash, signature, signer, body };
}

/** Persist a bundle to `<dataDir>/evidence/<runId>.json`; returns the path. */
export async function writeEvidence(
  bundle: EvidenceBundle,
  dataDir = path.resolve("data"),
): Promise<string> {
  const dir = path.join(dataDir, "evidence");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${bundle.runId}.json`);
  await fs.writeFile(file, JSON.stringify(bundle, bigintReplacer, 2), "utf8");
  return file;
}
