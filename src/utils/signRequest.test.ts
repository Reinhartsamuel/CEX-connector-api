import { test, expect } from "bun:test";
import { signRequest } from './signRequest';
import { GateCredentials } from "../schemas/interfaces";

const mockCredentials: GateCredentials = {
  key: 'test-api-key',
  secret: 'test-api-secret'
};

const mockOptions = {
  method: 'POST',
  urlPath: '/api/v4/futures/orders',
  queryString: 'settle=usdt',
  payload: JSON.stringify({ symbol: 'BTC_USDT', size: 1, price: 50000 })
};

test('should generate headers with correct structure', () => {
  const headers = signRequest(mockCredentials, mockOptions);

  expect(headers).toHaveProperty('KEY');
  expect(headers).toHaveProperty('Timestamp');
  expect(headers).toHaveProperty('SIGN');
  
  expect(headers.KEY).toBe(mockCredentials.key);
  expect(typeof headers.Timestamp).toBe('string');
  expect(typeof headers.SIGN).toBe('string');
  expect(headers.SIGN).toHaveLength(128); // SHA512 hex string is 128 chars
});

test('should generate different signatures for different payloads', () => {
  const options1 = { ...mockOptions, payload: 'payload1' };
  const options2 = { ...mockOptions, payload: 'payload2' };

  const headers1 = signRequest(mockCredentials, options1);
  const headers2 = signRequest(mockCredentials, options2);

  expect(headers1.SIGN).not.toBe(headers2.SIGN);
});

test('should generate different signatures for different secrets', () => {
  const credentials1 = { ...mockCredentials, secret: 'secret1' };
  const credentials2 = { ...mockCredentials, secret: 'secret2' };

  const headers1 = signRequest(credentials1, mockOptions);
  const headers2 = signRequest(credentials2, mockOptions);

  expect(headers1.SIGN).not.toBe(headers2.SIGN);
});

test('should include timestamp in reasonable range', () => {
  const before = Math.floor(Date.now() / 1000);
  const headers = signRequest(mockCredentials, mockOptions);
  const after = Math.floor(Date.now() / 1000);
  
  const timestamp = parseInt(headers.Timestamp);
  expect(timestamp).toBeGreaterThanOrEqual(before);
  expect(timestamp).toBeLessThanOrEqual(after);
});

test('should handle empty query string', () => {
  const options = { ...mockOptions, queryString: '' };
  const headers = signRequest(mockCredentials, options);

  expect(headers).toHaveProperty('SIGN');
  expect(headers.SIGN).toHaveLength(128);
});

test('should handle empty payload', () => {
  const options = { ...mockOptions, payload: '' };
  const headers = signRequest(mockCredentials, options);

  expect(headers).toHaveProperty('SIGN');
  expect(headers.SIGN).toHaveLength(128);
});

test('should generate different signatures for different timestamps', async () => {
  const headers1 = signRequest(mockCredentials, mockOptions);
  
  // Wait a moment to ensure timestamp would be different
  await Bun.sleep(1000);
  
  const headers2 = signRequest(mockCredentials, mockOptions);
  
  // Signatures should be different due to timestamp
  expect(headers1.SIGN).not.toBe(headers2.SIGN);
});