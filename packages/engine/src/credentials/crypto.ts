import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const HKDF_INFO = "thodare-credential-v1";
const AES_ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;

export function deriveOrgKey(masterKey: Uint8Array, organizationId: string): Uint8Array {
  // Defense-in-depth: HKDF accepts any IKM length, but Thodare requires
  // exactly 32 bytes so weak keys (e.g., 16-byte cuts) cannot flow through
  // even if a caller bypasses the boot validation in server.ts.
  if (masterKey.length !== KEY_LENGTH) {
    throw new Error(`masterKey must be ${KEY_LENGTH} bytes, got ${masterKey.length}`);
  }
  const salt = Buffer.from(organizationId, "utf8");
  const info = Buffer.from(HKDF_INFO, "ascii");
  return new Uint8Array(hkdfSync("sha256", masterKey, salt, info, KEY_LENGTH));
}

export function encryptSecret(
  orgKey: Uint8Array,
  plaintext: string,
): { iv: Uint8Array; ciphertext: Uint8Array; authTag: Uint8Array } {
  if (orgKey.length !== KEY_LENGTH) {
    throw new Error(`orgKey must be ${KEY_LENGTH} bytes, got ${orgKey.length}`);
  }
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(AES_ALGORITHM, orgKey, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return { iv, ciphertext, authTag };
}

export function decryptSecret(
  orgKey: Uint8Array,
  blob: { iv: Uint8Array; ciphertext: Uint8Array; authTag: Uint8Array },
): string {
  if (orgKey.length !== KEY_LENGTH) {
    throw new Error(`orgKey must be ${KEY_LENGTH} bytes, got ${orgKey.length}`);
  }
  if (blob.iv.length !== IV_LENGTH) {
    throw new Error(`iv must be ${IV_LENGTH} bytes, got ${blob.iv.length}`);
  }
  if (blob.authTag.length !== AUTH_TAG_LENGTH) {
    throw new Error(`authTag must be ${AUTH_TAG_LENGTH} bytes, got ${blob.authTag.length}`);
  }
  const decipher = createDecipheriv(AES_ALGORITHM, orgKey, blob.iv);
  decipher.setAuthTag(Buffer.from(blob.authTag));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(blob.ciphertext)),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

export function packEncrypted(blob: {
  iv: Uint8Array;
  ciphertext: Uint8Array;
  authTag: Uint8Array;
}): Buffer {
  return Buffer.concat([
    Buffer.from(blob.iv),
    Buffer.from(blob.authTag),
    Buffer.from(blob.ciphertext),
  ]);
}

export function unpackEncrypted(buf: Buffer): {
  iv: Uint8Array;
  ciphertext: Uint8Array;
  authTag: Uint8Array;
} {
  if (buf.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error(
      `encrypted blob too short: ${buf.length} bytes (need at least ${IV_LENGTH + AUTH_TAG_LENGTH})`,
    );
  }
  const iv = new Uint8Array(buf.subarray(0, IV_LENGTH));
  const authTag = new Uint8Array(buf.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH));
  const ciphertext = new Uint8Array(buf.subarray(IV_LENGTH + AUTH_TAG_LENGTH));
  return { iv, ciphertext, authTag };
}
