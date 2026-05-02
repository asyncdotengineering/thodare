import { describe, expect, it } from "vitest";
import {
  deriveOrgKey,
  encryptSecret,
  decryptSecret,
  packEncrypted,
  unpackEncrypted,
} from "../src/credentials/crypto.js";

const masterKey = new Uint8Array(32);
// Fill with predictable bytes for deterministic tests
for (let i = 0; i < 32; i++) masterKey[i] = i;

describe("HKDF key derivation", () => {
  it("same (masterKey, organizationId) produces the same orgKey", () => {
    const k1 = deriveOrgKey(masterKey, "org-a");
    const k2 = deriveOrgKey(masterKey, "org-a");
    expect(new Uint8Array(k1)).toEqual(new Uint8Array(k2));
    expect(k1.length).toBe(32);
  });

  it("different orgs produce different keys", () => {
    const k1 = deriveOrgKey(masterKey, "org-a");
    const k2 = deriveOrgKey(masterKey, "org-b");
    expect(new Uint8Array(k1)).not.toEqual(new Uint8Array(k2));
  });
});

describe("AES-256-GCM encrypt / decrypt round-trip", () => {
  it("encrypt → pack → unpack → decrypt returns original plaintext", () => {
    const orgKey = deriveOrgKey(masterKey, "test-org");
    const plaintext = "hello world secret data";
    const encrypted = encryptSecret(orgKey, plaintext);
    expect(encrypted.iv.length).toBe(12);
    expect(encrypted.authTag.length).toBe(16);
    expect(encrypted.ciphertext.length).toBeGreaterThan(0);

    const packed = packEncrypted(encrypted);
    expect(packed.length).toBe(12 + 16 + encrypted.ciphertext.length);

    const unpacked = unpackEncrypted(packed);
    const decrypted = decryptSecret(orgKey, unpacked);
    expect(decrypted).toBe(plaintext);
  });

  it("tampered ciphertext causes decryptSecret to throw", () => {
    const orgKey = deriveOrgKey(masterKey, "test-org");
    const plaintext = "sensitive data";
    const encrypted = encryptSecret(orgKey, plaintext);
    const packed = packEncrypted(encrypted);

    // Flip a byte in the ciphertext portion (byte 30 = past iv + authTag)
    const tampered = Buffer.from(packed);
    const ciphertextStart = 12 + 16;
    if (tampered.length > ciphertextStart) {
      tampered[ciphertextStart] = tampered[ciphertextStart]! ^ 0x01;
    }
    const unpacked = unpackEncrypted(tampered);
    expect(() => decryptSecret(orgKey, unpacked)).toThrow();
  });
});
