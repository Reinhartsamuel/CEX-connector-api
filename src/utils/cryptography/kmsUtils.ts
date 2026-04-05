// kmsSessionCrypto.ts
import crypto from "crypto";
import {
  KMSClient,
  GenerateDataKeyCommand,
  DecryptCommand,
} from "@aws-sdk/client-kms";

// ---------- CONFIG ----------
const KMS_KEY_ID = process.env.KMS_KEY_ID!;
const REGION = process.env.AWS_REGION!;
const ALGO = "aes-256-gcm";
const IV_LENGTH = 12;
const DEK_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ---------- IN-MEMORY DEK CACHE ----------
// Stores plaintext DEKs in process memory only — never Redis, never disk.
// Eliminates one KMS round-trip per trade for the same exchange within the TTL window.
// Threat model: if the process is compromised, the DEK is exposed for up to TTL.
// Mitigations: short TTL, zeroing on eviction, no persistence.
interface CachedDEK {
  dek: Buffer;
  expiresAt: number;
}
const dekCache = new Map<number, CachedDEK>();

/**
 * Returns the plaintext DEK for the given exchange, decrypting via KMS only on
 * cache miss or TTL expiry. The returned Buffer is owned by the cache — callers
 * must NOT call .fill(0) on it.
 */
export async function getOrDecryptDEK(exchangeId: number, encDEK: Uint8Array): Promise<Buffer> {
  const cached = dekCache.get(exchangeId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.dek;
  }

  // Zero and evict the stale entry before fetching a fresh one
  if (cached) {
    cached.dek.fill(0);
    dekCache.delete(exchangeId);
  }

  const dekResp = await kmsClient.send(
    new DecryptCommand({
      CiphertextBlob: encDEK,
      EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
    }),
  );
  if (!dekResp.Plaintext) throw new Error("KMS decrypt failed");

  const dek = Buffer.from(dekResp.Plaintext);
  dekCache.set(exchangeId, { dek, expiresAt: Date.now() + DEK_CACHE_TTL_MS });
  return dek;
}

export const kmsClient = new KMSClient({
  region: process.env.AWS_REGION!,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

// ---------- TYPES ----------
type EncryptedPayload = {
  iv: string;
  tag: string;
  ciphertext: string;
};

type EncryptedCredentialRow = {
  encryptedDEK: Uint8Array;
  apiKey: EncryptedPayload;
  apiSecret: EncryptedPayload;
  passphrase?: EncryptedPayload;
};

// ---------- DEK GENERATION (ONCE, STORE RESULT) ----------
export async function generateAndEncryptCredentials(
  apiKey: string,
  apiSecret: string,
  passphrase?: string
): Promise<EncryptedCredentialRow> {
  const t0 = performance.now();

  const { Plaintext, CiphertextBlob } = await kmsClient.send(
    new GenerateDataKeyCommand({
      KeyId: KMS_KEY_ID,
      KeySpec: "AES_256",
    })
  );

  if (!Plaintext || !CiphertextBlob) {
    throw new Error("Failed to generate DEK");
  }

  const dek = Buffer.from(Plaintext);

  const row: EncryptedCredentialRow = {
    encryptedDEK: CiphertextBlob,
    apiKey: encrypt(apiKey, dek),
    apiSecret: encrypt(apiSecret, dek),
    passphrase: passphrase ? encrypt(passphrase, dek) : undefined,
  };

  // zero plaintext DEK
  dek.fill(0);

  console.log(`[${(performance.now() - t0).toFixed(2)}ms] generateAndEncryptCredentials`);
  return row;
}



// ---------- CRYPTO ----------
export function encrypt(plaintext: string, dek: Buffer): EncryptedPayload {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGO, dek, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return {
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

export function decrypt(payload: EncryptedPayload, dek: Buffer): string {
  const iv = Buffer.from(payload.iv, "base64");
  const tag = Buffer.from(payload.tag, "base64");
  const ciphertext = Buffer.from(payload.ciphertext, "base64");

  const decipher = crypto.createDecipheriv(ALGO, dek, iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}

// Best-effort zeroing for JS strings
function zeroString(str: string) {
  // strings are immutable; this just drops reference
  str = "";
}

// // ---------- EXECUTION SESSION ----------
// export async function withExecutionSession<T>(
//   row: EncryptedCredentialRow,
//   fn: (creds: { apiKey: string; apiSecret: string; passphrase?: string }) => Promise<T>
// ): Promise<T> {
//   const t0 = performance.now();

//   // 1. Decrypt DEK ONCE
//   const dekResp = await kmsClient.send(
//     new DecryptCommand({
//       CiphertextBlob: row.encryptedDEK,
//       EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
//     })
//   );

//   if (!dekResp.Plaintext) {
//     throw new Error("Failed to decrypt DEK");
//   }

//   const dek = Buffer.from(dekResp.Plaintext);

//   // 2. Decrypt credentials
//   const apiKey = decrypt(row.apiKey, dek);
//   const apiSecret = decrypt(row.apiSecret, dek);
//   const passphrase = row.passphrase
//     ? decrypt(row.passphrase, dek)
//     : undefined;

//   console.log(`[${(performance.now() - t0).toFixed(2)}ms] session setup`);

//   try {
//     // 3. Execute user logic (trades, WS, etc.)
//     return await fn({ apiKey, apiSecret, passphrase });
//   } finally {
//     // 4. Zero everything
//     dek.fill(0);
//     zeroString(apiKey);
//     zeroString(apiSecret);
//     if (passphrase) zeroString(passphrase);
//   }
// }

// ---------- DEMO ----------
// async function example() {
//   const row = await generateAndEncryptCredentials(
//     "my-api-key-123",
//     "my-api-secret-456",
//     "okx-passphrase"
//   );

//   await withExecutionSession(row, async ({ apiKey }) => {
//     console.log("Executing trade 1 with", apiKey.slice(0, 4), "***");
//     console.log("Executing trade 2");
//     console.log("Executing trade 3");
//   });

//   console.log("Session finished");
// }

// example().catch(console.error);
