/**
 * HTTP calls the MCP tools make. No retries. Secrets stay in headers or the
 * settle body and are never copied into errors.
 */

export const DEFAULT_BASE_URL = "https://wardpass-gateway-staging.fly.dev";
export const LOOKUP_TIMEOUT_MS = 10_000;
export const SETTLE_TIMEOUT_MS = 60_000;

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
};

export type SettleResult =
  | { type: "settled"; fields: Record<string, unknown> }
  | { type: "approval_required"; approvalId?: string; expiresAt?: string }
  | { type: "awaiting_approval"; approvalId?: string; expiresAt?: string }
  | { type: "outcome_unknown"; code: string }
  | { type: "denied"; errorReason: string }
  | { type: "error"; code: string; message: string };

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
      body: JSON.stringify({
        policyPassport: passport,
        paymentRequirements: call.paymentRequirements,
        paymentPayload: call.paymentPayload,
        idempotencyKey: call.idempotencyKey,
      }),
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
  const code = errorCode(record, status);

  if (status === 409) {
    if (code === "reservation_awaiting_approval") {
      return { type: "awaiting_approval", ...approvalFields(record) };
    }
    return { type: "outcome_unknown", code };
  }

  if (status !== 200) {
    return { type: "error", code, message: errorMessage(record, code) };
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

  return { type: "error", code: "malformed_response", message: "the gateway returned an unexpected settle body" };
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

function approvalFields(body: Record<string, unknown>): { approvalId?: string; expiresAt?: string } {
  const pending = asRecord(body.pendingApproval);
  const approvalId = stringField(pending.approvalId) ?? stringField(body.approvalId);
  const expiresAt = stringField(pending.expiresAt) ?? stringField(body.expiresAt);
  return {
    ...(approvalId ? { approvalId } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  };
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
