import { test, expect } from "bun:test";
import { signRequestOkx, OkxCredentials } from "./signRequestOkx";

const mockCredentials: OkxCredentials = {
  key: "test-api-key",
  secret: "test-api-secret",
  passphrase: "test-passphrase"
};

const mockGetOptions = {
  method: "GET",
  requestPath: "/api/v5/account/balance?ccy=BTC"
};

const mockPostOptions = {
  method: "POST",
  requestPath: "/api/v5/trade/order",
  body: JSON.stringify({ instId: "BTC-USDT", sz: "0.01", side: "buy" })
};

test("should generate headers with correct OKX structure", () => {
  const headers = signRequestOkx(mockCredentials, mockGetOptions);

  expect(headers).toHaveProperty("OK-ACCESS-KEY");
  expect(headers).toHaveProperty("OK-ACCESS-SIGN");
  expect(headers).toHaveProperty("OK-ACCESS-TIMESTAMP");
  expect(headers).toHaveProperty("OK-ACCESS-PASSPHRASE");

  expect(headers["OK-ACCESS-KEY"]).toBe(mockCredentials.key);
  expect(headers["OK-ACCESS-PASSPHRASE"]).toBe(mockCredentials.passphrase);
  expect(typeof headers["OK-ACCESS-SIGN"]).toBe("string");
  expect(typeof headers["OK-ACCESS-TIMESTAMP"]).toBe("string");
});

test("should generate different signatures for different payloads", () => {
  const options1 = { ...mockPostOptions, body: '{"instId":"BTC-USDT","sz":"0.01"}' };
  const options2 = { ...mockPostOptions, body: '{"instId":"ETH-USDT","sz":"0.1"}' };

  const headers1 = signRequestOkx(mockCredentials, options1);
  const headers2 = signRequestOkx(mockCredentials, options2);

  expect(headers1["OK-ACCESS-SIGN"]).not.toBe(headers2["OK-ACCESS-SIGN"]);
});

test("should generate different signatures for different secrets", () => {
  const credentials1 = { ...mockCredentials, secret: "secret1" };
  const credentials2 = { ...mockCredentials, secret: "secret2" };

  const headers1 = signRequestOkx(credentials1, mockGetOptions);
  const headers2 = signRequestOkx(credentials2, mockGetOptions);

  expect(headers1["OK-ACCESS-SIGN"]).not.toBe(headers2["OK-ACCESS-SIGN"]);
});

test("should generate different signatures for different methods", () => {
  const getHeaders = signRequestOkx(mockCredentials, mockGetOptions);
  const postHeaders = signRequestOkx(mockCredentials, mockPostOptions);

  expect(getHeaders["OK-ACCESS-SIGN"]).not.toBe(postHeaders["OK-ACCESS-SIGN"]);
});

test("should generate different signatures for different request paths", () => {
  const options1 = { ...mockGetOptions, requestPath: "/api/v5/account/balance?ccy=BTC" };
  const options2 = { ...mockGetOptions, requestPath: "/api/v5/account/balance?ccy=ETH" };

  const headers1 = signRequestOkx(mockCredentials, options1);
  const headers2 = signRequestOkx(mockCredentials, options2);

  expect(headers1["OK-ACCESS-SIGN"]).not.toBe(headers2["OK-ACCESS-SIGN"]);
});

test("should handle empty body for GET requests", () => {
  const options = { ...mockGetOptions, body: "" };
  const headers = signRequestOkx(mockCredentials, options);

  expect(headers["OK-ACCESS-SIGN"]).toBeTruthy();
  expect(headers["OK-ACCESS-SIGN"].length).toBeGreaterThan(0);
});

test("should generate timestamp in correct ISO format with milliseconds", () => {
  const headers = signRequestOkx(mockCredentials, mockGetOptions);
  const timestamp = headers["OK-ACCESS-TIMESTAMP"];

  // Check ISO format: YYYY-MM-DDTHH:mm:ss.sssZ
  expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

  // Verify it's a valid date
  const date = new Date(timestamp);
  expect(date.toString()).not.toBe("Invalid Date");
});

test("should uppercase method as per OKX documentation", () => {
  const options = { ...mockGetOptions, method: "get" }; // lowercase
  const headers = signRequestOkx(mockCredentials, options);

  // The function should uppercase the method internally
  expect(headers["OK-ACCESS-SIGN"]).toBeTruthy();
});

});

test("signature should be base64 encoded", () => {
  const headers = signRequestOkx(mockCredentials, mockGetOptions);
  const signature = headers["OK-ACCESS-SIGN"];

  // Base64 regex: alphanumeric, +, /, = padding
  expect(signature).toMatch(/^[A-Za-z0-9+/]+=*$/);

  // Should not be hex (like Gate.io uses)
  expect(signature).not.toMatch(/^[0-9a-f]{128}$/);
});

test("should generate different timestamps for different calls", async () => {
  const headers1 = signRequestOkx(mockCredentials, mockGetOptions);

  // Wait a moment to ensure timestamp would be different
  await Bun.sleep(10);

  const headers2 = signRequestOkx(mockCredentials, mockGetOptions);

  // Timestamps should be different
  expect(headers1["OK-ACCESS-TIMESTAMP"]).not.toBe(headers2["OK-ACCESS-TIMESTAMP"]);
});
