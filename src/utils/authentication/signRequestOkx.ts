
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
 * Helper function to create request path with query parameters for GET requests
 * According to OKX documentation: GET request parameters are counted as requestpath, not body
 *
 * @param endpoint Base endpoint path (e.g., '/api/v5/account/balance')
 * @param queryParams Query parameters as object
 * @returns Full request path with query string
 */
export function createOkxRequestPath(
  endpoint: string,
  queryParams?: Record<string, string | number | boolean>
): string {
  if (!queryParams || Object.keys(queryParams).length === 0) {
    return endpoint;
  }

  const queryString = Object.entries(queryParams)
    .map(([key, value]) => `${key}=${encodeURIComponent(value.toString())}`)
    .join('&');

  return `${endpoint}?${queryString}`;
}

/**
 * Example usage:
 *
 * ```typescript
 * const credentials = {
 *   key: 'your-api-key',
 *   secret: 'your-secret-key',
 *   passphrase: 'your-passphrase'
 * };
 *
 * // For GET request with query parameters
 * const getOptions = {
 *   method: 'GET',
 *   requestPath: createOkxRequestPath('/api/v5/account/balance', { ccy: 'BTC' })
 * };
 * const getHeaders = signRequestOkx(credentials, getOptions);
 *
 * // For POST request with body
 * const postOptions = {
 *   method: 'POST',
 *   requestPath: '/api/v5/trade/order',
 *   body: JSON.stringify({ instId: 'BTC-USDT', sz: '0.01', side: 'buy' })
 * };
 * const postHeaders = signRequestOkx(credentials, postOptions);
 * ```
 */
