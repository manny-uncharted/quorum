import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

const keypair = new Ed25519Keypair();
const address = keypair.getPublicKey().toSuiAddress();
const privateKey = keypair.getSecretKey();

console.log("=========================================");
console.log("       Sui Wallet Generated Successfully ");
console.log("=========================================");
console.log(`Address:      ${address}`);
console.log(`Private Key:  ${privateKey}`);
console.log("=========================================");
console.log("To use this wallet in your Quorum desk:");
console.log("1. Copy the Private Key above.");
console.log("2. Paste it in your .env file as:");
console.log(`   SUI_PRIVATE_KEY=${privateKey}`);
console.log("=========================================");
