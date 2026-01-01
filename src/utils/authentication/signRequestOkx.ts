
import * as crypto from 'crypto';
import { OkxSignRequestOptions } from '../../schemas/interfaces';

/**
 * OKX API credentials including passphrase (required for OKX)
 */
export interface OkxCredentials {
  key: string;
  secret: string;
  passphrase: string;
}

/**
 * Options for signing OKX REST API requests
 */


/**
 * Generates the required headers for an OKX REST API signed request
 * according to OKX API documentation:
 *
 * Headers required:
 * - OK-ACCESS-KEY: The API key as a String
 * - OK-ACCESS-SIGN: The Base64-encoded signature
 * - OK-ACCESS-TIMESTAMP: The UTC timestamp with millisecond ISO format
 * - OK-ACCESS-PASSPHRASE: The passphrase specified when creating the API key
 * - Content-Type: application/json (for requests with body)
 *
 * Note: Request bodies should have content type application/json and be in valid JSON format.
 *
 * Signature generation:
 * 1. Create a pre-hash string of timestamp + method + requestPath + body
 * 2. Sign the pre-hash string with the SecretKey using HMAC SHA256
 * 3. Encode the signature in Base64 format
 *
 * @param credentials OKX API credentials (key, secret, passphrase)
 * @param options Request signing options (method, requestPath, body)
 * @returns Headers object for OKX REST API request
 */
export function signRequestOkx(
  credentials: OkxCredentials,
  options: OkxSignRequestOptions
): Record<string, string> {
  // Generate timestamp in ISO format with milliseconds as required by OKX
  // e.g., 2020-12-08T09:08:57.715Z
  const timestamp = new Date().toISOString();

  // Method should be in UPPERCASE as per OKX documentation
  const method = options.method.toUpperCase();

  // Body raw
  const body = options?.body ? options.body : '';

  // Create pre-hash string: timestamp + method + requestPath + body
  const preHashString = timestamp + method + options.requestPath + body;

  // Sign the pre-hash string with the secret key using HMAC SHA256
  const hmac = crypto.createHmac('sha256', credentials.secret);
  hmac.update(preHashString);
  const signature = hmac.digest('base64');

  // Return headers as per OKX API documentation
  return {
    'OK-ACCESS-KEY': credentials.key,
    'OK-ACCESS-SIGN': signature,
    'OK-ACCESS-TIMESTAMP': timestamp,
    'OK-ACCESS-PASSPHRASE': credentials.passphrase,
  };
}

/**
 * Generates an OKX API signature.
 * * @param timestamp - REST: ISO 8601 string | WS: Unix Epoch seconds string
 * @param method - HTTP Method (e.g., 'GET' or 'POST')
 * @param requestPath - API Endpoint (e.g., '/api/v5/account/balance' or '/users/self/verify')
 * @param secretKey - Your API Secret Key
 * @param body - JSON string of the request body (leave as empty string for GET or WS login)
 */
export function signRequestOkxWs(
  timestamp: string,
  method: string,
  requestPath: string,
  secretKey: string,
  body: string = ""
): string {
  // 1. Construct the pre-hash string
  const prehash = `${timestamp}${method.toUpperCase()}${requestPath}${body}`;

  // 2. Create HMAC SHA256 and encode to Base64
  return crypto
    .createHmac('sha256', secretKey)
    .update(prehash)
    .digest('base64');
}
