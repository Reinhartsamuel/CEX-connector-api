import * as crypto from 'crypto';
import { GateCredentials, SignRequestOptions, WebSocketAuthOptions } from '../schemas/interfaces';



/**
 * Generates the required headers for a Gate.io APIv4 signed request
 * Replicates the Go implementation for consistency
 */
export function signRequestRest(
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

/**
 * Generates authentication for Gate.io WebSocket API
 * Follows the official WebSocket documentation format
 */
export function signWebSocketRequest(
  credentials: GateCredentials,
  options: WebSocketAuthOptions
): Record<string, string> {
  const timestamp = options.timestamp || Math.floor(Date.now() / 1000);

  // Build signature string exactly as per WebSocket documentation
  const sigStr = `channel=${options.channel}&event=${options.event}&time=${timestamp}`;

  // Generate HMAC-SHA512 signature using the secret
  const hmac = crypto.createHmac('sha512', credentials.secret);
  hmac.update(sigStr);
  const signature = hmac.digest('hex');

  return {
    'method': 'api_key',
    'KEY': credentials.key,
    'SIGN': signature,
  };
}

/**
 * Usage example for WebSocket authentication:
 *
 * const auth = signWebSocketRequest(credentials, {
 *   channel: 'futures.orders',
 *   event: 'subscribe',
 * });
 *
 * const wsMessage = {
 *   id: Date.now(),
 *   time: Math.floor(Date.now() / 1000),
 *   channel: 'futures.orders',
 *   event: 'subscribe',
 *   payload: ['20011', 'BTC_USD'],
 *   auth: auth
 * };
 */
