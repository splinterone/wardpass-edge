import { test } from "node:test";
import assert from "node:assert/strict";
import { WardPassClient } from "../dist/index.js";

const BASE = "https://wardpass-gateway-staging.fly.dev";
const PASSPORT = "passport_testvalue_hygiene_xyz";

const requirements = {
  amount: "1000",
  payTo: "So11111111111111111111111111111111111111112",
  network: "solana:mainnet",
  asset: "USDC",
};

const payload = { x402Version: 1, payload: { signature: "sig" } };

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("WardPassClient.settlePayment sends reservationId and maps a final 409", async () => {
  const calls = [];
  const result = await WardPassClient.settlePayment({
    baseUrl: `${BASE}/`,
    passport: PASSPORT,
    paymentRequirements: requirements,
    paymentPayload: payload,
    idempotencyKey: "idem-lib-01",
    reservationId: "res_lib_1",
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse(409, { error: "amount_exceeds_hold", detail: "1010 > 1000" });
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${BASE}/settle`);
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.policyPassport, PASSPORT);
  assert.equal(sent.reservationId, "res_lib_1");
  assert.equal(sent.idempotencyKey, "idem-lib-01");
  assert.deepEqual(sent.paymentRequirements, requirements);
  assert.equal(result.type, "error");
  assert.equal(result.code, "amount_exceeds_hold");
  assert.match(result.message, /higher than the hold/);
  assert.match(result.message, /do not retry with a new idempotency key/i);
  assert.equal(result.message.includes("1010"), false);
  assert.equal(result.message.includes("SAME idempotencyKey"), false);
});

test("WardPassClient.settlePayment omits reservationId and keeps settlement_unknown retryable", async () => {
  let fetches = 0;
  const result = await WardPassClient.settlePayment({
    baseUrl: BASE,
    passport: PASSPORT,
    paymentRequirements: requirements,
    paymentPayload: payload,
    idempotencyKey: "idem-lib-02",
    fetch: async (_url, init) => {
      fetches += 1;
      const sent = JSON.parse(init.body);
      assert.equal(Object.hasOwn(sent, "reservationId"), false);
      return jsonResponse(409, { error: "settlement_unknown" });
    },
  });
  assert.equal(fetches, 1);
  assert.equal(result.type, "outcome_unknown");
  assert.equal(result.code, "settlement_unknown");
});

test("WardPassClient.settlePayment returns reservationId from an approval body", async () => {
  const result = await WardPassClient.settlePayment({
    baseUrl: BASE,
    passport: PASSPORT,
    paymentRequirements: requirements,
    paymentPayload: payload,
    idempotencyKey: "idem-lib-03",
    fetch: async () => jsonResponse(200, {
      success: false,
      errorReason: "approval_required",
      pendingApproval: { approvalId: "ap_lib", expiresAt: "2026-04-01T00:00:00Z", reservationId: "res_lib_pending" },
    }),
  });
  assert.equal(result.type, "approval_required");
  assert.equal(result.approvalId, "ap_lib");
  assert.equal(result.reservationId, "res_lib_pending");
});

test("a blank reservationId is left off the settle body", async () => {
  const result = await WardPassClient.settlePayment({
    baseUrl: BASE,
    passport: PASSPORT,
    paymentRequirements: requirements,
    paymentPayload: payload,
    idempotencyKey: "idem-lib-04",
    reservationId: "   ",
    fetch: async (_url, init) => {
      const sent = JSON.parse(init.body);
      assert.equal(Object.hasOwn(sent, "reservationId"), false);
      return jsonResponse(200, { success: true, txSignature: "tx_lib" });
    },
  });
  assert.equal(result.type, "settled");
  assert.equal(result.fields.txSignature, "tx_lib");
});
