/**
 * Sui testnet client + signer.
 *
 * The signer is optional: read-only flows (the market feed, previews) work without
 * a key, so the desk can render markets before any wallet is configured.
 */

import { SuiClient } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { fromHex } from "@mysten/sui/utils";

import { SUI_RPC_URL } from "./constants.js";

export const client = new SuiClient({ url: SUI_RPC_URL });

/**
 * Load the signer from `SUI_PRIVATE_KEY`. Accepts a bech32 `suiprivkey1...`
 * string (the `sui keytool` default) or a 64-char hex secret key.
 * Throws with an actionable message when missing — callers that only read
 * should not invoke this.
 */
export function loadKeypair(): Ed25519Keypair {
  const raw = process.env.SUI_PRIVATE_KEY?.trim();
  if (!raw) {
    throw new Error(
      "SUI_PRIVATE_KEY is not set. Add a testnet key to .env (see .env.example).",
    );
  }
  if (raw.startsWith("suiprivkey")) {
    const { secretKey } = decodeSuiPrivateKey(raw);
    return Ed25519Keypair.fromSecretKey(secretKey);
  }
  const hex = raw.startsWith("0x") ? raw.slice(2) : raw;
  return Ed25519Keypair.fromSecretKey(fromHex(hex));
}

/** Convenience: the active address, or null if no key is configured. */
export function activeAddress(): string | null {
  try {
    return loadKeypair().getPublicKey().toSuiAddress();
  } catch {
    return null;
  }
}
