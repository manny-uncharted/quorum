/**
 * DeepBook Predict — testnet contract surface.
 *
 * Verified against the Sui docs "Contract Information" page and the
 * `predict-testnet-4-16` branch of MystenLabs/deepbookv3. Treat these as the
 * single source of truth; every transaction builder reads from here so a redeploy
 * is a one-file change.
 */

export const NETWORK = "testnet" as const;

export const SUI_RPC_URL =
  process.env.SUI_RPC_URL ?? "https://fullnode.testnet.sui.io:443";

export const PREDICT_SERVER_URL =
  process.env.PREDICT_SERVER_URL ??
  "https://predict-server.testnet.mystenlabs.com";

/** The shared `Clock` object — required by mint/redeem/preview calls. */
export const CLOCK_OBJECT_ID = "0x6" as const;

export const PREDICT = {
  /** Move package that defines the `predict` module. */
  packageId:
    "0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138",
  /** Shared `Predict` object (vault + config + accepted quotes). */
  predictObjectId:
    "0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a",
  /** Shared `Registry` object. */
  registryId:
    "0x43af14fed5480c20ff77e2263d5f794c35b9fab7e2212903127062f4fe2a6e64",
} as const;

/** Enabled quote asset for testnet markets. */
export const DUSDC = {
  type: "0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC",
  currencyId:
    "0xf3000dff421833d4bb8ed58fac146d691a3aaba2785aa1989af65a7089ca3e9c",
  decimals: 6,
} as const;

/** Predict LP share token minted by `supply`. */
export const PLP_TYPE = `${PREDICT.packageId}::plp::PLP` as const;

/** Fully-qualified `predict` module path for `moveCall` targets. */
export const PREDICT_MODULE = `${PREDICT.packageId}::predict` as const;
