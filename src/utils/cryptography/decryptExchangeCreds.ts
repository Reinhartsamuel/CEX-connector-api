import { DecryptCommand } from "@aws-sdk/client-kms";
import { postgresDb } from "../../db/client";
import { exchanges } from "../../db/schema";
import { eq } from "drizzle-orm";
import { kmsClient, decrypt } from "./kmsUtils";
import { createLogger } from "../logger";

const log = createLogger({ process: 'kms', component: 'decrypt-creds' });

export interface DecryptedCreds {
  apiKey: string;
  apiSecret: string;
  passphrase?: string;
  exchangeId: number;
}

/**
 * Fetch an exchange record by exchange_user_id and decrypt its credentials via KMS.
 * Used by WS workers that need credentials but only have the exchange_user_id.
 *
 * Returns null if the exchange record doesn't exist or decryption fails.
 */
export async function decryptExchangeCreds(
  exchangeUserId: string,
): Promise<DecryptedCreds | null> {
  const exchange = await postgresDb.query.exchanges.findFirst({
    where: eq(exchanges.exchange_user_id, exchangeUserId),
  });

  if (!exchange || !exchange.enc_dek) {
    log.warn({ exchangeUserId }, 'No exchange or enc_dek found');
    return null;
  }

  let plaintextDEK: Buffer | null = null;
  try {
    const dekResp = await kmsClient.send(
      new DecryptCommand({
        CiphertextBlob: exchange.enc_dek,
        EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
      }),
    );

    if (!dekResp.Plaintext) {
      log.error({ exchangeUserId }, 'KMS decrypt returned no plaintext');
      return null;
    }

    plaintextDEK = Buffer.from(dekResp.Plaintext);

    const apiKey = decrypt(JSON.parse(exchange.api_key_encrypted), plaintextDEK);
    const apiSecret = decrypt(JSON.parse(exchange.api_secret_encrypted), plaintextDEK);
    const passphrase = exchange.api_passphrase_encrypted
      ? decrypt(JSON.parse(exchange.api_passphrase_encrypted), plaintextDEK)
      : undefined;

    return { apiKey, apiSecret, passphrase, exchangeId: exchange.id };
  } catch (err) {
    log.error({ err, exchangeUserId }, 'Credential decryption failed');
    return null;
  } finally {
    if (plaintextDEK) plaintextDEK.fill(0);
  }
}
