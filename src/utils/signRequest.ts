import * as crypto from 'crypto';
import { GateCredentials, SignRequestOptions } from '../schemas/interfaces';

/**
 * Generates the required headers for a Gate.io APIv4 signed request
 * Replicates the Go implementation for consistency
 */
export function signRequest(
  credentials: GateCredentials,
  options: SignRequestOptions
): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000);

  // Hash payload with SHA512
  const hash = crypto.createHash('sha512');
  if (options.payload) {
    hash.update(options.payload);
  }
  const hashedPayload = hash.digest('hex');

  // Build signature string exactly as per documentation
  const sigStr = `${options.method}\n${options.urlPath}\n${options.queryString}\n${hashedPayload}\n${timestamp}`;

  // Generate HMAC-SHA512 signature using the secret
  const hmac = crypto.createHmac('sha512', credentials.secret);
  hmac.update(sigStr);
  const signature = hmac.digest('hex');

  return {
    'KEY': credentials.key,
    'Timestamp': timestamp.toString(),
    'SIGN': signature,
  };
}
