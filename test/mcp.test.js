import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createWardPassMcpServer } from "../dist/mcp-server.js";

const ADDRESS = "So11111111111111111111111111111111111111112";
const KEY = "abok_testkeyvalue_hygiene";
const PASSPORT = "passport_testvalue_hygiene_xyz";
const BASE = "https://wardpass-gateway-staging.fly.dev";

const APPROVAL =
  "A human must approve this payment in Telegram or the WardPass console. Do not retry with a new idempotencyKey, do not split it into smaller payments, and do not try another route. After approval the gateway completes it.";
const AWAITING =
  "This payment is waiting on human approval in Telegram or the WardPass console. Retry later with the same idempotency key. Do not invent a new one, do not split the payment, and do not try another route.";
const UNKNOWN = "Do not pay again. Retry only with the SAME idempotencyKey.";

const screenArgs = {
  agentId: "agent_1",
  payTo: ADDRESS,
  amount: "1000",
  asset: "USDC",
  network: "solana:mainnet",
};

const requirements = {
  amount: "1000",
  payTo: ADDRESS,
  network: "solana:mainnet",
  asset: "USDC",
  scheme: "exact",
  extra: { feePayer: "payer_1" },
};

const payload = {
  x402Version: 1,
  payload: { signature: "sig", nested: { a: 1 } },
  unexpected: true,
};

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function header(init, name) {
  const headers = init?.headers ?? {};
  if (typeof headers.get === "function") return headers.get(name);
  const found = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase());
  return found ? headers[found] : undefined;
}

async function connect(env, fetchImpl) {
  const mcp = createWardPassMcpServer({ env, fetch: fetchImpl });
  const client = new Client({ name: "wardpass-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), mcp.connect(serverTransport)]);
  return client;
}

function textOf(result) {
  return result.content.map((part) => part.text).join("\n");
}

test("tools/list returns exactly the three tools with input schemas", async () => {
  let fetches = 0;
  const client = await connect({}, () => {
    fetches += 1;
    throw new Error("unexpected fetch");
  });
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["wardpass_check_wallet", "wardpass_screen_payment", "wardpass_settle_payment"]
    );
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    assert.equal(byName.wardpass_check_wallet.inputSchema.type, "object");
    assert.ok(byName.wardpass_check_wallet.inputSchema.properties.address);
    assert.equal(byName.wardpass_check_wallet.annotations.readOnlyHint, true);
    assert.match(byName.wardpass_screen_payment.description, /allow means WardPass found no reason to stop this payment\. It is not a guarantee\./);
    assert.match(byName.wardpass_screen_payment.description, /insufficient_data is not an allow/);
    assert.ok(byName.wardpass_screen_payment.inputSchema.properties.amount);
    assert.equal(byName.wardpass_screen_payment.inputSchema.additionalProperties, false);
    assert.match(byName.wardpass_settle_payment.description, /Caps and human approval are enforced by WardPass/);
    assert.match(byName.wardpass_settle_payment.description, /Splitting a payment to get under an approval threshold is not allowed/);
    assert.equal(byName.wardpass_settle_payment.annotations.destructiveHint, true);
    assert.match(
      byName.wardpass_settle_payment.inputSchema.properties.paymentPayload.description,
      /not strict/
    );
    const settleRequired = byName.wardpass_settle_payment.inputSchema.required ?? [];
    assert.equal(settleRequired.includes("reservationId"), false);
    assert.match(
      byName.wardpass_settle_payment.inputSchema.properties.reservationId.description,
      /Optional reservation id/
    );
    assert.equal(fetches, 0);
  } finally {
    await client.close();
  }
});

test("unknown keys and bad address, amount, and idempotencyKey are rejected before fetch", async () => {
  let fetches = 0;
  const fetchImpl = () => {
    fetches += 1;
    throw new Error("unexpected fetch");
  };
  const client = await connect({ WARDPASS_KEY: KEY, WARDPASS_PASSPORT: PASSPORT }, fetchImpl);
  const rejected = async (request, pattern) => {
    const result = await client.callTool(request);
    assert.equal(result.isError, true);
    assert.match(textOf(result), pattern);
  };
  try {
    await rejected(
      { name: "wardpass_check_wallet", arguments: { address: ADDRESS, extra: 1 } },
      /Unrecognized key/
    );
    await rejected(
      { name: "wardpass_check_wallet", arguments: { address: "not-a-solana-address" } },
      /Invalid arguments/
    );
    await rejected(
      { name: "wardpass_screen_payment", arguments: { ...screenArgs, amount: "0", nope: true } },
      /Unrecognized key/
    );
    await rejected(
      { name: "wardpass_screen_payment", arguments: { ...screenArgs, amount: "0" } },
      /amount must be greater than 0/
    );
    await rejected(
      {
        name: "wardpass_settle_payment",
        arguments: {
          paymentRequirements: requirements,
          paymentPayload: payload,
          idempotencyKey: "short",
          extra: true,
        },
      },
      /Unrecognized key/
    );
    await rejected(
      {
        name: "wardpass_settle_payment",
        arguments: {
          paymentRequirements: requirements,
          paymentPayload: payload,
          idempotencyKey: "short",
        },
      },
      /Invalid arguments/
    );
    await rejected(
      {
        name: "wardpass_settle_payment",
        arguments: {
          paymentRequirements: { ...requirements, unknownField: "x" },
          paymentPayload: payload,
          idempotencyKey: "idem-key-01",
        },
      },
      /Unrecognized key/
    );
    assert.equal(fetches, 0);
  } finally {
    await client.close();
  }
});

test("check_wallet maps a 200 lookup and sends the mcp source header", async () => {
  const calls = [];
  const body = {
    address: ADDRESS,
    chain: "solana",
    partial: false,
    cached: false,
    walletAge: { firstTransactionAt: "2020-01-01T00:00:00Z", ageSeconds: 10, exact: true },
    funding: { classification: "mixed", uniqueFunders: 2, shape: "fan" },
    frequency: { txCount: 3, txPerDay: 0.1, capped: false, cap: 100 },
    bureau: {},
    isLab: false,
    source: "mcp",
    mode: "preview",
    advisory: "Signals, not a guarantee.",
  };
  const client = await connect({}, async (url, init) => {
    calls.push({ url: String(url), init });
    return jsonResponse(200, body);
  });
  try {
    const result = await client.callTool({ name: "wardpass_check_wallet", arguments: { address: ADDRESS } });
    assert.equal(result.isError, undefined);
    assert.ok(textOf(result).endsWith("Signals, not a guarantee."));
    assert.equal(textOf(result).includes("allow"), false);
    assert.equal(textOf(result).includes("deny"), false);
    assert.equal(result.structuredContent.advisory, "Signals, not a guarantee.");
    assert.equal(result.structuredContent.address, ADDRESS);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${BASE}/v1/lookup/${ADDRESS}`);
    assert.equal(calls[0].init.method, "GET");
    assert.equal(header(calls[0].init, "X-WardPass-Source"), "mcp");
    assert.equal(header(calls[0].init, "authorization"), undefined);
  } finally {
    await client.close();
  }
});

test("check_wallet 429 is an error with lookup_rate_limited", async () => {
  const client = await connect({}, async () => jsonResponse(429, { error: "lookup_rate_limited" }, { "retry-after": "3" }));
  try {
    const result = await client.callTool({ name: "wardpass_check_wallet", arguments: { address: ADDRESS } });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.code, "lookup_rate_limited");
    assert.match(textOf(result), /lookup_rate_limited/);
    assert.equal(textOf(result).includes("at "), false);
  } finally {
    await client.close();
  }
});

test("screen sends the operator key and source header", async () => {
  const calls = [];
  const client = await connect({ WARDPASS_KEY: KEY, WARDPASS_AGENT_ID: "agent_from_env" }, async (url, init) => {
    calls.push({ url: String(url), init });
    return jsonResponse(200, {
      decision: "allow",
      confidence: "low",
      reasons: ["known agent"],
      screenId: "scr_1",
    });
  });
  try {
    const result = await client.callTool({
      name: "wardpass_screen_payment",
      arguments: { payTo: ADDRESS, amount: "1000", asset: "USDC", network: "solana:mainnet" },
    });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.decision, "allow");
    assert.equal(result.structuredContent.confidence, "low");
    assert.deepEqual(result.structuredContent.reasons, ["known agent"]);
    assert.equal(result.structuredContent.screenId, "scr_1");
    assert.match(textOf(result), /allow means WardPass found no reason to stop this payment\. It is not a guarantee\./);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${BASE}/v1/screen/outbound`);
    assert.equal(header(calls[0].init, "authorization"), `Bearer ${KEY}`);
    assert.equal(header(calls[0].init, "X-WardPass-Source"), "mcp");
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      agentId: "agent_from_env",
      payTo: ADDRESS,
      amount: "1000",
      asset: "USDC",
      network: "solana:mainnet",
    });
  } finally {
    await client.close();
  }
});

test("insufficient_data is not described as an allow", async () => {
  const client = await connect({ WARDPASS_KEY: KEY }, async () => jsonResponse(200, {
    decision: "insufficient_data",
    confidence: "low",
    factors: ["thin history"],
    screenId: "scr_2",
  }));
  try {
    const result = await client.callTool({ name: "wardpass_screen_payment", arguments: screenArgs });
    assert.equal(result.structuredContent.decision, "insufficient_data");
    assert.deepEqual(result.structuredContent.reasons, ["thin history"]);
    assert.match(textOf(result), /insufficient_data is not an allow/);
    assert.match(textOf(result), /It is not a guarantee/);
  } finally {
    await client.close();
  }
});

test("screen 403 is an error and does not include request headers", async () => {
  const client = await connect({ WARDPASS_KEY: KEY }, async () => jsonResponse(403, { error: "operator_key_required" }));
  try {
    const result = await client.callTool({ name: "wardpass_screen_payment", arguments: screenArgs });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.code, "operator_key_required");
    const dumped = JSON.stringify(result);
    assert.equal(dumped.includes("authorization"), false);
    assert.equal(dumped.includes(KEY), false);
  } finally {
    await client.close();
  }
});

test("missing WARDPASS_KEY returns an error and does not fetch", async () => {
  let fetches = 0;
  const client = await connect({}, () => {
    fetches += 1;
    throw new Error("unexpected fetch");
  });
  try {
    const result = await client.callTool({ name: "wardpass_screen_payment", arguments: screenArgs });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /POST \/v1\/signup/);
    assert.match(textOf(result), /WardPass console/);
    assert.equal(fetches, 0);
  } finally {
    await client.close();
  }
});

test("settle success is settled and forwards the body unchanged", async () => {
  const calls = [];
  const client = await connect({ WARDPASS_PASSPORT: PASSPORT }, async (url, init) => {
    calls.push({ url: String(url), init });
    return jsonResponse(200, { success: true, txSignature: "tx_1", receipt: { id: "rcpt_1" } });
  });
  try {
    const idempotencyKey = "idem-key-01";
    const result = await client.callTool({
      name: "wardpass_settle_payment",
      arguments: { paymentRequirements: requirements, paymentPayload: payload, idempotencyKey },
    });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.status, "settled");
    assert.equal(result.structuredContent.txSignature, "tx_1");
    assert.deepEqual(result.structuredContent.receipt, { id: "rcpt_1" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${BASE}/settle`);
    assert.equal(header(calls[0].init, "authorization"), undefined);
    const sent = JSON.parse(calls[0].init.body);
    assert.equal(sent.policyPassport, PASSPORT);
    assert.deepEqual(sent.paymentRequirements, requirements);
    assert.deepEqual(sent.paymentPayload, payload);
    assert.equal(sent.idempotencyKey, idempotencyKey);
    assert.equal(Object.hasOwn(sent, "reservationId"), false);
  } finally {
    await client.close();
  }
});

test("approval_required is a normal result, one fetch, and never calls admin", async () => {
  const calls = [];
  const client = await connect({ WARDPASS_PASSPORT: PASSPORT }, async (url, init) => {
    calls.push({ url: String(url), init });
    return jsonResponse(200, {
      success: false,
      errorReason: "approval_required",
      pendingApproval: { approvalId: "ap_1", expiresAt: "2026-01-02T00:00:00Z" },
    });
  });
  try {
    const result = await client.callTool({
      name: "wardpass_settle_payment",
      arguments: { paymentRequirements: requirements, paymentPayload: payload, idempotencyKey: "idem-key-02" },
    });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.status, "approval_required");
    assert.equal(result.structuredContent.approvalId, "ap_1");
    assert.equal(result.structuredContent.expiresAt, "2026-01-02T00:00:00Z");
    assert.equal(result.structuredContent.instruction, APPROVAL);
    assert.match(textOf(result), /A human must approve this payment in Telegram or the WardPass console/);
    assert.equal(calls.length, 1);
    assert.equal(calls.some((call) => String(call.url).includes("/admin")), false);
  } finally {
    await client.close();
  }
});

test("409 reservation_awaiting_approval is pending, not final and not unknown", async () => {
  const calls = [];
  const client = await connect({ WARDPASS_PASSPORT: PASSPORT }, async (url, init) => {
    calls.push({ url: String(url), init });
    return jsonResponse(409, {
      success: false,
      code: "reservation_awaiting_approval",
      errorReason: "settlement_in_progress",
      error: "settlement_unknown",
      reservationId: "res_pending_9",
      idempotencyKey: "idem-key-03",
      pendingApproval: { approvalId: "ap_9", expiresAt: "2026-02-01T00:00:00Z" },
    });
  });
  try {
    const result = await client.callTool({
      name: "wardpass_settle_payment",
      arguments: {
        paymentRequirements: requirements,
        paymentPayload: payload,
        idempotencyKey: "idem-key-03",
        reservationId: "res_pending_9",
      },
    });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.status, "awaiting_approval");
    assert.equal(result.structuredContent.approvalId, "ap_9");
    assert.equal(result.structuredContent.reservationId, "res_pending_9");
    assert.equal(result.structuredContent.instruction, AWAITING);
    assert.match(textOf(result), /waiting on human approval/);
    assert.match(textOf(result), /Retry later with the same idempotency key/);
    assert.equal(result.structuredContent.status === "outcome_unknown", false);
    assert.equal(textOf(result).includes("SAME idempotencyKey"), false);
    assert.equal(calls.length, 1);
    assert.equal(JSON.parse(calls[0].init.body).idempotencyKey, "idem-key-03");
  } finally {
    await client.close();
  }
});

test("settle sends reservationId only when you pass one", async () => {
  const calls = [];
  const client = await connect({ WARDPASS_PASSPORT: PASSPORT }, async (url, init) => {
    calls.push({ url: String(url), init });
    return jsonResponse(200, { success: true, txSignature: "tx_hold" });
  });
  try {
    const held = await client.callTool({
      name: "wardpass_settle_payment",
      arguments: {
        paymentRequirements: requirements,
        paymentPayload: payload,
        idempotencyKey: "idem-key-hold-1",
        reservationId: "  res_hold_1  ",
      },
    });
    assert.equal(held.isError, undefined);
    assert.equal(held.structuredContent.status, "settled");
    const sent = JSON.parse(calls[0].init.body);
    assert.equal(sent.reservationId, "res_hold_1");
    assert.equal(sent.policyPassport, PASSPORT);
    assert.equal(sent.idempotencyKey, "idem-key-hold-1");
    assert.deepEqual(sent.paymentRequirements, requirements);
    assert.deepEqual(sent.paymentPayload, payload);

    const bare = await client.callTool({
      name: "wardpass_settle_payment",
      arguments: {
        paymentRequirements: requirements,
        paymentPayload: payload,
        idempotencyKey: "idem-key-hold-2",
      },
    });
    assert.equal(bare.structuredContent.status, "settled");
    assert.equal(Object.hasOwn(JSON.parse(calls[1].init.body), "reservationId"), false);
    assert.equal(calls.length, 2);
  } finally {
    await client.close();
  }
});

test("a bad reservationId is rejected before fetch", async () => {
  let fetches = 0;
  const client = await connect({ WARDPASS_PASSPORT: PASSPORT }, () => {
    fetches += 1;
    throw new Error("unexpected fetch");
  });
  try {
    const result = await client.callTool({
      name: "wardpass_settle_payment",
      arguments: {
        paymentRequirements: requirements,
        paymentPayload: payload,
        idempotencyKey: "idem-key-hold-3",
        reservationId: "not a hold",
      },
    });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /Invalid arguments/);
    assert.equal(fetches, 0);
  } finally {
    await client.close();
  }
});

test("approval responses surface reservationId for the next settle", async () => {
  let mode = "approval";
  const client = await connect({ WARDPASS_PASSPORT: PASSPORT }, async () => {
    if (mode === "approval") {
      return jsonResponse(200, {
        success: false,
        errorReason: "approval_required",
        reservationId: "res_from_approval",
        pendingApproval: { approvalId: "ap_hold", expiresAt: "2026-03-01T00:00:00Z" },
      });
    }
    return jsonResponse(409, {
      error: "reservation_awaiting_approval",
      pendingApproval: {
        approvalId: "ap_wait",
        expiresAt: "2026-03-02T00:00:00Z",
        reservationId: "res_from_pending",
      },
    });
  });
  try {
    const approval = await client.callTool({
      name: "wardpass_settle_payment",
      arguments: { paymentRequirements: requirements, paymentPayload: payload, idempotencyKey: "idem-key-ap-1" },
    });
    assert.equal(approval.isError, undefined);
    assert.equal(approval.structuredContent.status, "approval_required");
    assert.equal(approval.structuredContent.reservationId, "res_from_approval");
    mode = "awaiting";
    const waiting = await client.callTool({
      name: "wardpass_settle_payment",
      arguments: { paymentRequirements: requirements, paymentPayload: payload, idempotencyKey: "idem-key-ap-2" },
    });
    assert.equal(waiting.structuredContent.status, "awaiting_approval");
    assert.equal(waiting.structuredContent.reservationId, "res_from_pending");
    assert.equal(waiting.structuredContent.approvalId, "ap_wait");
  } finally {
    await client.close();
  }
});

const FINAL_REFUSALS = [
  ["reservation_already_settled", /already settled/],
  ["reservation_released", /was released/],
  ["reservation_expired", /has expired/],
  ["reservation_not_open", /not open for settle/],
  ["reservation_passport_mismatch", /different Policy Passport/],
  ["reservation_bound_to_other_payment", /different payment/],
  ["amount_exceeds_hold", /higher than the hold/],
  ["amount_below_hold", /lower than the hold/],
  ["reservation_agent_mismatch", /different agent/],
];

test("final 409 reservation refusals are not retried as unknown", async () => {
  let fetches = 0;
  let body = {};
  const client = await connect({ WARDPASS_PASSPORT: PASSPORT }, async (_url, init) => {
    fetches += 1;
    const sent = JSON.parse(init.body);
    assert.equal(sent.idempotencyKey, `idem-final-${String(fetches).padStart(2, "0")}`);
    assert.equal(sent.reservationId, "res_final");
    return jsonResponse(409, body);
  });
  try {
    for (const [code, pattern] of FINAL_REFUSALS) {
      const before = fetches;
      body = {
        success: false,
        code,
        errorReason: "not_the_machine_code",
        error: "settlement_unknown",
      };
      const result = await client.callTool({
        name: "wardpass_settle_payment",
        arguments: {
          paymentRequirements: requirements,
          paymentPayload: payload,
          idempotencyKey: `idem-final-${String(before + 1).padStart(2, "0")}`,
          reservationId: "res_final",
        },
      });
      assert.equal(fetches, before + 1);
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent.status, undefined);
      assert.equal(result.structuredContent.code, code);
      assert.match(textOf(result), pattern);
      assert.match(textOf(result), /do not retry with a new idempotency key/i);
      assert.equal(textOf(result).includes("SAME idempotencyKey"), false);
      assert.equal(textOf(result).includes("not_the_machine_code"), false);
      assert.equal(result.structuredContent.status === "outcome_unknown", false);
    }
  } finally {
    await client.close();
  }
});

test("404 reservation_not_found with a reservationId is a final refusal", async () => {
  let fetches = 0;
  const client = await connect({ WARDPASS_PASSPORT: PASSPORT }, async (_url, init) => {
    fetches += 1;
    const sent = JSON.parse(init.body);
    assert.equal(sent.reservationId, "res_missing");
    return jsonResponse(404, {
      success: false,
      code: "reservation_not_found",
      errorReason: "no such hold",
      error: "not_found",
    });
  });
  try {
    const result = await client.callTool({
      name: "wardpass_settle_payment",
      arguments: {
        paymentRequirements: requirements,
        paymentPayload: payload,
        idempotencyKey: "idem-missing-01",
        reservationId: "res_missing",
      },
    });
    assert.equal(fetches, 1);
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.code, "reservation_not_found");
    assert.equal(result.structuredContent.status, undefined);
    assert.match(textOf(result), /does not know that reservation/);
    assert.match(textOf(result), /do not retry with a new idempotency key/i);
    assert.equal(textOf(result).includes("SAME idempotencyKey"), false);
    assert.equal(textOf(result).includes("no such hold"), false);
  } finally {
    await client.close();
  }
});

test("settle code falls back from code to errorReason to error", async () => {
  const cases = [
    {
      body: { code: "amount_below_hold", errorReason: "settlement_in_progress", error: "settlement_unknown" },
      code: "amount_below_hold",
    },
    {
      body: { errorReason: "reservation_expired", error: "settlement_unknown" },
      code: "reservation_expired",
    },
    {
      body: { error: "reservation_released" },
      code: "reservation_released",
    },
    {
      body: { error: "reservation_awaiting_approval", pendingApproval: { approvalId: "ap_old" } },
      code: "reservation_awaiting_approval",
      awaiting: true,
    },
  ];
  let fetches = 0;
  const client = await connect({ WARDPASS_PASSPORT: PASSPORT }, async () => {
    const next = cases[fetches];
    fetches += 1;
    return jsonResponse(409, next.body);
  });
  try {
    for (let i = 0; i < cases.length; i += 1) {
      const result = await client.callTool({
        name: "wardpass_settle_payment",
        arguments: {
          paymentRequirements: requirements,
          paymentPayload: payload,
          idempotencyKey: `idem-fallback-${String(i + 1).padStart(2, "0")}`,
          reservationId: "res_fallback",
        },
      });
      if (cases[i].awaiting) {
        assert.equal(result.isError, undefined);
        assert.equal(result.structuredContent.status, "awaiting_approval");
        assert.equal(result.structuredContent.approvalId, "ap_old");
        assert.equal(result.structuredContent.instruction, AWAITING);
      } else {
        assert.equal(result.isError, true);
        assert.equal(result.structuredContent.code, cases[i].code);
        assert.equal(result.structuredContent.status, undefined);
        assert.equal(textOf(result).includes("SAME idempotencyKey"), false);
      }
    }
    assert.equal(fetches, cases.length);
  } finally {
    await client.close();
  }
});

test("settlement_unknown honours retryAfterMs and does not use errorReason", async () => {
  const client = await connect({ WARDPASS_PASSPORT: PASSPORT }, async () => jsonResponse(409, {
    success: false,
    errorReason: "settlement_in_progress",
    code: "settlement_unknown",
    idempotencyKey: "idem-unk-01",
    retryAfterMs: 2500,
  }));
  try {
    const result = await client.callTool({
      name: "wardpass_settle_payment",
      arguments: {
        paymentRequirements: requirements,
        paymentPayload: payload,
        idempotencyKey: "idem-unk-01",
        reservationId: "res_unk",
      },
    });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.status, "outcome_unknown");
    assert.equal(result.structuredContent.code, "settlement_unknown");
    assert.equal(result.structuredContent.retryAfterMs, 2500);
    assert.match(textOf(result), /Do not pay again\. Retry only with the SAME idempotencyKey\./);
    assert.match(textOf(result), /Wait at least 2500ms before you retry/);
    assert.equal(textOf(result).includes("settlement_in_progress"), false);
  } finally {
    await client.close();
  }
});

test("409 settlement_in_progress and settlement_unknown are outcome_unknown", async () => {
  let code = "settlement_in_progress";
  const client = await connect({ WARDPASS_PASSPORT: PASSPORT }, async () => jsonResponse(409, { error: code }));
  try {
    const inProgress = await client.callTool({
      name: "wardpass_settle_payment",
      arguments: { paymentRequirements: requirements, paymentPayload: payload, idempotencyKey: "idem-key-04" },
    });
    assert.equal(inProgress.isError, true);
    assert.equal(inProgress.structuredContent.status, "outcome_unknown");
    assert.equal(inProgress.structuredContent.code, "settlement_in_progress");
    assert.match(textOf(inProgress), /Do not pay again\. Retry only with the SAME idempotencyKey\./);
    code = "settlement_unknown";
    const unknown = await client.callTool({
      name: "wardpass_settle_payment",
      arguments: { paymentRequirements: requirements, paymentPayload: payload, idempotencyKey: "idem-key-04b" },
    });
    assert.equal(unknown.structuredContent.status, "outcome_unknown");
    assert.equal(unknown.structuredContent.code, "settlement_unknown");
    assert.match(textOf(unknown), /SAME idempotencyKey/);
  } finally {
    await client.close();
  }
});

test("a 409 with no code or an unrecognized code stays outcome_unknown", async () => {
  const queue = [
    {},
    { detail: "facilitator said nothing useful" },
    { error: "some_future_gateway_code" },
    { error: "" },
  ];
  let fetches = 0;
  const client = await connect({ WARDPASS_PASSPORT: PASSPORT }, async () => {
    const next = queue[fetches];
    fetches += 1;
    return jsonResponse(409, next);
  });
  try {
    for (let i = 0; i < queue.length; i += 1) {
      const result = await client.callTool({
        name: "wardpass_settle_payment",
        arguments: {
          paymentRequirements: requirements,
          paymentPayload: payload,
          idempotencyKey: `idem-old-${String(i + 1).padStart(2, "0")}`,
        },
      });
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent.status, "outcome_unknown");
      assert.match(textOf(result), /Do not pay again\. Retry only with the SAME idempotencyKey\./);
      assert.equal(textOf(result).includes("facilitator said nothing"), false);
    }
    assert.equal(fetches, queue.length);
  } finally {
    await client.close();
  }
});

test("HTTP 200 screening and cap failures stay denied", async () => {
  const reasons = ["per_payment_cap_exceeded", "screen_deny"];
  let fetches = 0;
  const client = await connect({ WARDPASS_PASSPORT: PASSPORT }, async () => {
    const errorReason = reasons[fetches];
    fetches += 1;
    return jsonResponse(200, { success: false, errorReason });
  });
  try {
    for (const errorReason of reasons) {
      const result = await client.callTool({
        name: "wardpass_settle_payment",
        arguments: {
          paymentRequirements: requirements,
          paymentPayload: payload,
          idempotencyKey: `idem-deny-${errorReason}`,
        },
      });
      assert.equal(result.isError, undefined);
      assert.equal(result.structuredContent.status, "denied");
      assert.equal(result.structuredContent.errorReason, errorReason);
      assert.equal(textOf(result).includes("SAME idempotencyKey"), false);
      assert.equal(textOf(result).includes("new idempotency key"), false);
    }
  } finally {
    await client.close();
  }
});

test("a settle fetch timeout is outcome_unknown and not denied", async () => {
  let fetches = 0;
  const client = await connect({ WARDPASS_PASSPORT: PASSPORT }, async () => {
    fetches += 1;
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    throw err;
  });
  try {
    const result = await client.callTool({
      name: "wardpass_settle_payment",
      arguments: { paymentRequirements: requirements, paymentPayload: payload, idempotencyKey: "idem-key-05" },
    });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.status, "outcome_unknown");
    assert.equal(result.structuredContent.code, "timeout");
    assert.equal(result.structuredContent.status === "denied", false);
    assert.match(textOf(result), new RegExp(UNKNOWN.replace(/[.]/g, "\\.")));
    assert.equal(fetches, 1);
  } finally {
    await client.close();
  }
});

test("a settle network error is outcome_unknown and hides the client error", async () => {
  const client = await connect({ WARDPASS_PASSPORT: PASSPORT }, async () => {
    throw new Error("connect ECONNREFUSED 10.0.0.1");
  });
  try {
    const result = await client.callTool({
      name: "wardpass_settle_payment",
      arguments: { paymentRequirements: requirements, paymentPayload: payload, idempotencyKey: "idem-key-05b" },
    });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.status, "outcome_unknown");
    assert.equal(result.structuredContent.code, "network_error");
    assert.equal(textOf(result).includes("ECONNREFUSED"), false);
    assert.match(textOf(result), /SAME idempotencyKey/);
  } finally {
    await client.close();
  }
});

test("ambiguous settle responses are outcome_unknown and final client errors are not", async () => {
  const unknown = [
    { status: 500, body: JSON.stringify({ error: "internal_error" }), contentType: "application/json" },
    { status: 502, body: "<html><body>Bad Gateway</body></html>", contentType: "text/html" },
    { status: 503, body: JSON.stringify({ error: "unavailable" }), contentType: "application/json" },
    { status: 200, body: "<html>not json</html>", contentType: "text/html" },
  ];
  const finalErrors = [400, 401, 403, 404, 422];
  const queue = [
    ...unknown.map((item) => ({ ...item, unknown: true })),
    ...finalErrors.map((status) => ({
      status,
      body: JSON.stringify({ error: "malformed_request" }),
      contentType: "application/json",
      unknown: false,
    })),
  ];
  let fetches = 0;
  const client = await connect({ WARDPASS_PASSPORT: PASSPORT }, async () => {
    const next = queue[fetches];
    fetches += 1;
    if (!next) throw new Error("unexpected extra settle fetch");
    return new Response(next.body, {
      status: next.status,
      headers: { "content-type": next.contentType },
    });
  });
  try {
    for (let i = 0; i < queue.length; i += 1) {
      const result = await client.callTool({
        name: "wardpass_settle_payment",
        arguments: {
          paymentRequirements: requirements,
          paymentPayload: payload,
          idempotencyKey: `idem-key-${String(30 + i).padStart(2, "0")}`,
        },
      });
      assert.equal(result.isError, true);
      const dumped = JSON.stringify(result);
      assert.equal(dumped.includes("<html"), false);
      assert.equal(dumped.includes("Bad Gateway"), false);
      if (queue[i].unknown) {
        assert.equal(result.structuredContent.status, "outcome_unknown");
        assert.match(textOf(result), /Do not pay again\. Retry only with the SAME idempotencyKey\./);
      } else {
        assert.equal(result.structuredContent.status, undefined);
        assert.equal(result.structuredContent.code, "malformed_request");
        assert.equal(textOf(result).includes("SAME idempotencyKey"), false);
      }
    }
    assert.equal(fetches, queue.length);
  } finally {
    await client.close();
  }
});

test("success false with a policy reason is denied and the reason is passed through", async () => {
  const client = await connect({ WARDPASS_PASSPORT: PASSPORT }, async () => jsonResponse(200, {
    success: false,
    errorReason: "daily_cap_exceeded",
  }));
  try {
    const result = await client.callTool({
      name: "wardpass_settle_payment",
      arguments: { paymentRequirements: requirements, paymentPayload: payload, idempotencyKey: "idem-key-06" },
    });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.status, "denied");
    assert.equal(result.structuredContent.errorReason, "daily_cap_exceeded");
    assert.match(textOf(result), /daily_cap_exceeded/);
  } finally {
    await client.close();
  }
});

test("missing WARDPASS_PASSPORT returns an error and does not fetch", async () => {
  let fetches = 0;
  const client = await connect({}, () => {
    fetches += 1;
    throw new Error("unexpected fetch");
  });
  try {
    const result = await client.callTool({
      name: "wardpass_settle_payment",
      arguments: { paymentRequirements: requirements, paymentPayload: payload, idempotencyKey: "idem-key-07" },
    });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /Issue a Policy Passport for this agent in the WardPass console/);
    assert.equal(fetches, 0);
  } finally {
    await client.close();
  }
});

test("lookup aborts when WARDPASS_TIMEOUT_MS elapses", async () => {
  const client = await connect({ WARDPASS_TIMEOUT_MS: "40" }, (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      reject(err);
    });
  }));
  try {
    const result = await client.callTool({ name: "wardpass_check_wallet", arguments: { address: ADDRESS } });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.code, "timeout");
  } finally {
    await client.close();
  }
});

test("secrets never appear in tool results or captured stdio", async () => {
  const stderr = [];
  const stdout = [];
  const origErr = process.stderr.write.bind(process.stderr);
  const origOut = process.stdout.write.bind(process.stdout);
  process.stderr.write = (chunk, encoding, cb) => {
    stderr.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
    return origErr(chunk, encoding, cb);
  };
  process.stdout.write = (chunk, encoding, cb) => {
    stdout.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
    return origOut(chunk, encoding, cb);
  };

  const echo = { leakedKey: KEY, leakedPassport: PASSPORT, note: `see ${PASSPORT} and ${KEY}` };
  let settleMode = "ok";
  let lookups = 0;
  const client = await connect({ WARDPASS_KEY: KEY, WARDPASS_PASSPORT: PASSPORT }, async (url, init) => {
    const target = String(url);
    if (target.includes("/v1/lookup/")) {
      lookups += 1;
      if (lookups > 1) return jsonResponse(429, { error: "lookup_rate_limited", message: PASSPORT });
      return jsonResponse(200, { ...echo, address: ADDRESS, advisory: `Signals, not a guarantee. ${PASSPORT}` });
    }
    if (target.endsWith("/v1/screen/outbound")) {
      const sent = JSON.parse(init.body);
      if (sent.amount === "2") return jsonResponse(403, { error: "operator_key_required", message: KEY });
      if (sent.amount === "3") {
        return jsonResponse(200, { decision: "insufficient_data", confidence: "low", reasons: [PASSPORT], screenId: KEY });
      }
      return jsonResponse(200, { decision: "allow", confidence: "low", reasons: [KEY], screenId: PASSPORT });
    }
    if (settleMode === "timeout") {
      const err = new Error(`aborted ${PASSPORT}`);
      err.name = "AbortError";
      throw err;
    }
    if (settleMode === "approval") {
      return jsonResponse(200, { success: false, errorReason: "approval_required", pendingApproval: { approvalId: PASSPORT, expiresAt: KEY } });
    }
    if (settleMode === "awaiting") {
      return jsonResponse(409, { error: "reservation_awaiting_approval", pendingApproval: { approvalId: KEY, expiresAt: PASSPORT } });
    }
    if (settleMode === "progress") {
      return jsonResponse(409, { error: "settlement_in_progress", detail: PASSPORT });
    }
    if (settleMode === "denied") {
      return jsonResponse(200, { success: false, errorReason: "daily_cap_exceeded", detail: `${KEY} ${PASSPORT}` });
    }
    return jsonResponse(200, { success: true, txSignature: PASSPORT, receipt: KEY });
  });

  const results = [];
  try {
    results.push(await client.callTool({ name: "wardpass_check_wallet", arguments: { address: ADDRESS } }));
    results.push(await client.callTool({ name: "wardpass_check_wallet", arguments: { address: ADDRESS } }));
    results.push(await client.callTool({ name: "wardpass_screen_payment", arguments: screenArgs }));
    results.push(await client.callTool({
      name: "wardpass_screen_payment",
      arguments: { ...screenArgs, amount: "3" },
    }));
    results.push(await client.callTool({
      name: "wardpass_screen_payment",
      arguments: { ...screenArgs, amount: "2" },
    }));
    const settle = (idempotencyKey) => client.callTool({
      name: "wardpass_settle_payment",
      arguments: { paymentRequirements: requirements, paymentPayload: payload, idempotencyKey },
    });
    results.push(await settle("idem-key-11"));
    settleMode = "approval";
    results.push(await settle("idem-key-12"));
    settleMode = "awaiting";
    results.push(await settle("idem-key-13"));
    settleMode = "progress";
    results.push(await settle("idem-key-14"));
    settleMode = "timeout";
    results.push(await settle("idem-key-15"));
    settleMode = "denied";
    results.push(await settle("idem-key-16"));
  } finally {
    await client.close();
    process.stderr.write = origErr;
    process.stdout.write = origOut;
  }

  const dumped = JSON.stringify({ results, stderr, stdout });
  assert.equal(dumped.includes(KEY), false);
  assert.equal(dumped.includes(PASSPORT), false);
  assert.match(JSON.stringify(results), /\[redacted\]/);
});

test("spawned server speaks only JSON-RPC on stdout", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const child = spawn(process.execPath, ["dist/mcp.js"], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      WARDPASS_KEY: KEY,
      WARDPASS_PASSPORT: PASSPORT,
    },
  });
  let stderr = "";
  const messages = [];
  let buf = "";
  const waiters = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).replace(/\r$/, "");
      buf = buf.slice(idx + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      assert.equal(message.jsonrpc, "2.0");
      const waiter = waiters.shift();
      if (waiter) waiter(message);
      else messages.push(message);
    }
  });
  const next = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`stdio timeout; stderr=${stderr}`)), 5000);
    const deliver = (message) => {
      clearTimeout(timer);
      resolve(message);
    };
    if (messages.length) deliver(messages.shift());
    else waiters.push(deliver);
  });

  try {
    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "smoke", version: "0.0.0" },
      },
    }) + "\n");
    const init = await next();
    assert.equal(init.id, 1);
    assert.equal(init.result.serverInfo.name, "wardpass-edge");
    assert.equal(init.result.serverInfo.version, "0.2.0");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
    const listed = await next();
    assert.equal(listed.id, 2);
    assert.deepEqual(
      listed.result.tools.map((tool) => tool.name),
      ["wardpass_check_wallet", "wardpass_screen_payment", "wardpass_settle_payment"]
    );
    assert.equal(stderr, "wardpass-edge-mcp 0.2.0 ready (key: set, passport: set)\n");
    assert.equal(stderr.includes(KEY), false);
    assert.equal(stderr.includes(PASSPORT), false);
    assert.equal(buf.trim(), "");
  } finally {
    child.kill();
    await once(child, "exit");
  }
});
