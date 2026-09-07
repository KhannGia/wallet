/**
 * Offline key generation for `./wallet keygen`.
 *
 * This is the only code in the project that ever holds a private key, and it
 * is deliberately not part of the API server. It writes nothing to disk: the
 * mnemonic goes to the terminal once, and storing it is the operator's job.
 *
 * In production this belongs on an air-gapped machine, with the mnemonic held
 * in an HSM or on paper in a safe -- never in .env, and never in this repo.
 */
import { deriveDepositAddress, generateWallet } from "@wallet/shared";

const { mnemonic, xpub } = generateWallet();

const rule = "=".repeat(72);

console.log(rule);
console.log("  SECRET RECOVERY PHRASE -- write it down, then clear this screen");
console.log(rule);
console.log();
// Numbered in rows so a human can copy it onto paper without losing their place.
const words = mnemonic.split(" ");
for (let row = 0; row < words.length; row += 4) {
    console.log(
        "  " +
            words
                .slice(row, row + 4)
                .map((word, column) => `${String(row + column + 1).padStart(2)}. ${word.padEnd(12)}`)
                .join(""),
    );
}
console.log();
console.log("  Anyone holding these words controls every deposit address below.");
console.log("  This phrase is NOT stored anywhere. Losing it loses the funds.");
console.log();

console.log(rule);
console.log("  EXTENDED PUBLIC KEY -- safe to deploy, cannot spend");
console.log(rule);
console.log();
console.log(`  WALLET_XPUB=${xpub}`);
console.log();
console.log("  Put that line in .env. The API server derives deposit addresses");
console.log("  from it and has no way to move the funds that arrive.");
console.log();

console.log(rule);
console.log("  First three deposit addresses, to verify against your backup");
console.log(rule);
console.log();
for (let index = 0; index < 3; index++) {
    console.log(`  m/44'/60'/0'/0/${index}  ${deriveDepositAddress(xpub, index)}`);
}
console.log();
