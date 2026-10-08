/**
 * HTTP calls the MCP tools make. No retries. Secrets stay in headers or the
 * settle body and are never copied into errors.
 */

export const DEFAULT_BASE_URL = "https://wardpass-gateway-staging.fly.dev";
export const LOOKUP_TIMEOUT_MS = 10_000;
export const SETTLE_TIMEOUT_MS = 120_000;

const SETTLE_FINAL_ERROR_STATUS = new Set([400, 401, 403, 404, 422]);

export type FetchLike = typeof fetch;

export type GatewayConfig = {
  baseUrl: string;
  apiKey?: string;
  passport?: string;
  agentId?: string;
  timeoutMs: number;
  fetchImpl: FetchLike;
};

export class GatewayFailure extends Error {
  readonly code: string;
  readonly timedOut: boolean;

  constructor(code: string, message: string, timedOut = false) {
    super(message);
    this.name = "GatewayFailure";
    this.code = code;
    this.timedOut = timedOut;
  }
}

export type SettleCall = {
  paymentRequirements: Record<string, unknown>;
  paymentPayload: Record<string, unknown>;
  idempotencyKey: string;
  /** From a reserve/approval response, or passed in by the caller. Sent only when set. */
  reservationId?: string;
};

export type SettleResult =
  | { type: "settled"; fields: Record<string, unknown> }
  | { type: "approval_required"; approvalId?: string; expiresAt?: string; reservationId?: string }
  | { type: "awaiting_approval"; approvalId?: string; expiresAt?: string; reservationId?: string }
  | { type: "outcome_unknown"; code: string; retryAfterMs?: number }
  | { type: "denied"; errorReason: string }
  | { type: "error"; code: string; message: string };

/**
 * Finished hold refusals. Do not retry these with a new idempotency key.
 *
 * `reservation_not_found` is HTTP 404, not 409. It is still a finished
 * refusal when the caller named a reservation. A later gateway change may
 * answer another agent's id with that same 404.
 *
 * `settlement_unknown` is not in this list. A facilitator timeout keeps
 * the hold, and the same idempotency key is the retry. Any other 409 code
 * is treated the same way, so an older gateway stays compatible.
 * `reservation_awaiting_approval` is pending, not a refusal and not unknown.
 */
const FINAL_REFUSAL_MESSAGES: Record<string, string> = {
  reservation_already_settled:
    "This hold is already settled. Do not settle it again, and do not retry with a new idempotency key.",
  reservation_released:
    "This hold was released. Do not retry with a new idempotency key. Reserve a new hold if you still need to pay.",
  reservation_expired:
    "This hold has expired. Do not retry with a new idempotency key. Reserve a new hold if you still need to pay.",
  reservation_not_open:
    "This hold is not open for settle. Do not retry with a new idempotency key.",
  reservation_passport_mismatch:
    "This hold was reserved with a different Policy Passport. Do not retry with a new idempotency key. Use the passport that created the hold.",
  reservation_bound_to_other_payment:
    "This hold is already tied to a different payment. Do not retry with a new idempotency key.",
  amount_exceeds_hold:
    "That amount is higher than the hold. Do not retry with a new idempotency key. Settle the held amount, or reserve a new hold for the higher amount.",
  amount_below_hold:
    "That amount is lower than the hold. Do not retry with a new idempotency key. Settle the held amount.",
  reservation_agent_mismatch:
    "This hold belongs to a different agent. Do not retry with a new idempotency key.",
  reservation_not_found:
    "WardPass does not know that reservation. Do not retry with a new idempotency key. Reserve a hold, then settle it with that reservationId.",
};

export type Env = Record<string, string | undefined>;

export function loadConfig(env: Env, fetchImpl: FetchLike): GatewayConfig {
  return {
    baseUrl: resolveBaseUrl(env.WARDPASS_URL),
    apiKey: nonempty(env.WARDPASS_KEY),
    passport: nonempty(env.WARDPASS_PASSPORT),
    agentId: nonempty(env.WARDPASS_AGENT_ID),
    timeoutMs: readTimeout(env.WARDPASS_TIMEOUT_MS, LOOKUP_TIMEOUT_MS),
    fetchImpl,
  };
}

export function resolveBaseUrl(raw: string | undefined): string {
  const value = nonempty(raw) ?? DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("WARDPASS_URL must be an http(s) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("WARDPASS_URL must be an http(s) URL");
  }
  return value.replace(/\/+$/, "");
}

export async function lookupWallet(cfg: GatewayConfig, address: string): Promise<Record<string, unknown>> {
  const { status, body } = await request(cfg, `/v1/lookup/${encodeURIComponent(address)}`, {
    method: "GET",
    headers: { "X-WardPass-Source": "mcp" },
  }, cfg.timeoutMs);
  if (status !== 200) throw httpFailure(status, body);
  return asRecord(body);
}

export async function screenOutbound(
  cfg: GatewayConfig,
  apiKey: string,
  payload: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const { status, body } = await request(cfg, "/v1/screen/outbound", {
    method: "POST",
    headers: {
      "X-WardPass-Source": "mcp",
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  }, cfg.timeoutMs);
  if (status !== 200) throw httpFailure(status, body);
  return asRecord(body);
}

export async function settlePayment(cfg: GatewayConfig, passport: string, call: SettleCall): Promise<SettleResult> {
  let status: number;
  let body: unknown;
  try {
    const res = await request(cfg, "/settle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(settleBody(passport, call)),
    }, SETTLE_TIMEOUT_MS);
    status = res.status;
    body = res.body;
  } catch (err) {
    if (err instanceof GatewayFailure && (err.timedOut || err.code === "network_error")) {
      return { type: "outcome_unknown", code: err.timedOut ? "timeout" : "network_error" };
    }
    return { type: "outcome_unknown", code: "network_error" };
  }

  const record = asRecord(body);
  const code = settleCode(record, status);

  if (status === 409) {
    if (code === "reservation_awaiting_approval") {
      return { type: "awaiting_approval", ...approvalFields(record) };
    }
    const refusal = finalRefusalMessage(code);
    if (refusal) return { type: "error", code, message: refusal };
    return unknownOutcome(code, record);
  }

  // 400/401/403/404/422 are finished responses, not a dropped connection.
  // 404 reservation_not_found is an unknown reservation id.
  if (status !== 200) {
    if (SETTLE_FINAL_ERROR_STATUS.has(status)) {
      const refusal = finalRefusalMessage(code);
      return { type: "error", code, message: refusal ?? errorMessage(record, code) };
    }
    return { type: "outcome_unknown", code };
  }

  if (record.success === true) {
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (key !== "success") fields[key] = value;
    }
    return { type: "settled", fields };
  }

  if (record.success === false) {
    const reason = typeof record.errorReason === "string" && record.errorReason ? record.errorReason : "denied";
    if (reason === "approval_required") {
      return { type: "approval_required", ...approvalFields(record) };
    }
    return { type: "denied", errorReason: reason };
  }

  return { type: "outcome_unknown", code: "malformed_response" };
}

function nonempty(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readTimeout(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return n;
}

async function request(
  cfg: GatewayConfig,
  path: string,
  init: RequestInit,
  timeoutMs: number
): Promise<{ status: number; body: unknown }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await cfg.fetchImpl(`${cfg.baseUrl}${path}`, { ...init, signal: ctrl.signal });
    const text = await res.text();
    let body: unknown = {};
    if (text) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = {};
      }
    }
    return { status: res.status, body };
  } catch (err) {
    if (ctrl.signal.aborted || isAbort(err)) {
      throw new GatewayFailure("timeout", "the gateway did not respond in time", true);
    }
    throw new GatewayFailure("network_error", "the gateway request failed");
  } finally {
    clearTimeout(timer);
  }
}

function isAbort(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: unknown }).name;
  return name === "AbortError" || name === "TimeoutError";
}

function asRecord(body: unknown): Record<string, unknown> {
  if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
  return {};
}

function errorCode(body: Record<string, unknown>, status: number): string {
  for (const key of ["error", "errorReason", "code"]) {
    const value = body[key];
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 200);
  }
  return `http_${status}`;
}

/** Settle puts the machine code in `code`, a reason in `errorReason`, and older gateways used `error`. */
function settleCode(body: Record<string, unknown>, status: number): string {
  for (const key of ["code", "errorReason", "error"]) {
    const value = body[key];
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 200);
  }
  return `http_${status}`;
}

function readRetryAfterMs(body: Record<string, unknown>): number | undefined {
  const value = body.retryAfterMs;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

function unknownOutcome(code: string, body: Record<string, unknown>): SettleResult {
  if (code !== "settlement_unknown") return { type: "outcome_unknown", code };
  const retryAfterMs = readRetryAfterMs(body);
  if (retryAfterMs == null) return { type: "outcome_unknown", code };
  return { type: "outcome_unknown", code, retryAfterMs };
}

function errorMessage(body: Record<string, unknown>, code: string): string {
  const message = body.message;
  if (typeof message === "string" && message.trim() && !looksLikeStack(message)) {
    return message.trim().slice(0, 300);
  }
  return code;
}

function looksLikeStack(message: string): boolean {
  return message.includes("\n") || message.includes(" at ");
}

function httpFailure(status: number, body: unknown): GatewayFailure {
  const record = asRecord(body);
  const code = errorCode(record, status);
  return new GatewayFailure(code, errorMessage(record, code));
}

function settleBody(passport: string, call: SettleCall): Record<string, unknown> {
  const body: Record<string, unknown> = {
    policyPassport: passport,
    paymentRequirements: call.paymentRequirements,
    paymentPayload: call.paymentPayload,
    idempotencyKey: call.idempotencyKey,
  };
  const reservationId = cleanReservationId(call.reservationId);
  if (reservationId) body.reservationId = reservationId;
  return body;
}

function cleanReservationId(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function finalRefusalMessage(code: string): string | undefined {
  return FINAL_REFUSAL_MESSAGES[code];
}

function approvalFields(body: Record<string, unknown>): {
  approvalId?: string;
  expiresAt?: string;
  reservationId?: string;
} {
  const pending = asRecord(body.pendingApproval);
  const approvalId = stringField(pending.approvalId) ?? stringField(body.approvalId);
  const expiresAt = stringField(pending.expiresAt) ?? stringField(body.expiresAt);
  const reservationId = cleanReservationId(stringField(body.reservationId) ?? stringField(pending.reservationId));
  return {
    ...(approvalId ? { approvalId } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(reservationId ? { reservationId } : {}),
  };
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
