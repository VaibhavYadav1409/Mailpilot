import crypto from "crypto";

// GMAIL_TOKEN_ENC_KEY must be a 32-byte key, hex-encoded (64 hex chars).
// Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
const KEY_HEX = process.env.GMAIL_TOKEN_ENC_KEY;
if (!KEY_HEX || KEY_HEX.length !== 64) {
  throw new Error("GMAIL_TOKEN_ENC_KEY env var must be a 64-character hex string (32 bytes)");
}
const KEY = Buffer.from(KEY_HEX, "hex");

const ALGO = "aes-256-gcm";

/** Encrypts a plaintext token. Output format: iv:authTag:ciphertext, all hex, so it's one string column. */
export function encryptToken(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${ciphertext.toString("hex")}`;
}

export function decryptToken(stored: string): string {
  const [ivHex, authTagHex, ciphertextHex] = stored.split(":");
  if (!ivHex || !authTagHex || !ciphertextHex) {
    throw new Error("Malformed encrypted token");
  }
  const decipher = crypto.createDecipheriv(ALGO, KEY, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, "hex")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}
