/**
 * wardpass-edge — thin phone-home client for WardPass hosted.
 * Plug into the free control plane (passports, reserve/settle, oversight, /v1/screen).
 * Does not implement the full gateway. Not a self-host of AgentBound.
 */

import {
  resolveBaseUrl,
  settlePayment as postSettle,
  SETTLE_TIMEOUT_MS,
  type GatewayConfig,
  type SettleResult,
} from "./gateway.js";

export type { SettleResult };

export type ScreenDecision = "allow" | "review" | "deny" | "insufficient_data";

export type ScreenResult = {
  decision: ScreenDecision;
  confidence?: string;
  score?: number;
  screenId?: string;
  factors?: Record<string, unknown>;
  [key: string]: unknown;
};

export type WardPassClientOptions = {
  /** Hosted API base, e.g. https://wardpass-gateway-staging.fly.dev (staging, not production) */
  baseUrl: string;
  /** Per-operator API key from free-tier signup (TN consent required). */
  apiKey: string;
  /** Optional operator id header. */
  operatorId?: string;
  fetch?: typeof fetch;
};

export class WardPassClient {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly operatorId?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: WardPassClientOptions) {
    if (!opts.baseUrl) throw new Error("baseUrl required");
    if (!opts.apiKey) throw new Error("apiKey required — complete hosted signup + Trust Network consent first");
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.operatorId = opts.operatorId;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
      "content-type": "application/json",
      ...extra,
    };
    if (this.operatorId) h["x-operator-id"] = this.operatorId;
    return h;
  }

  /**
   * Receiver-side helper: call hosted POST /v1/screen before irreversible settle.
   * Uses a **receiver** API key (abrk_…), not an operator key.
   */
  static async screenBeforeSettle(
    opts: {
      baseUrl: string;
      receiverApiKey: string;
      body: Record<string, unknown>;
      fetch?: typeof fetch;
    }
  ): Promise<ScreenResult> {
    const fetchImpl = opts.fetch ?? fetch;
    const base = opts.baseUrl.replace(/\/$/, "");
    const res = await fetchImpl(`${base}/v1/screen`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${opts.receiverApiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(opts.body),
    });
    const out = (await res.json()) as ScreenResult & { error?: string };
    if (!res.ok) throw new Error(out.error || `screen_http_${res.status}`);
    return out;
  }

  /**
   * Settle under a Policy Passport. Pass reservationId when you have one
   * from reserve or from an earlier approval response. This does not retry.
   *
   * A finished hold refusal comes back as type "error". Do not call again
   * with a new idempotency key. type "outcome_unknown" (facilitator timeout,
   * or a 409 this client does not recognize) keeps the hold: retry with the
   * same idempotency key.
   */
  static async settlePayment(opts: {
    baseUrl: string;
    passport: string;
    paymentRequirements: Record<string, unknown>;
    paymentPayload: Record<string, unknown>;
    idempotencyKey: string;
    reservationId?: string;
    fetch?: typeof fetch;
  }): Promise<SettleResult> {
    if (!opts.baseUrl) throw new Error("baseUrl required");
    if (!opts.passport) throw new Error("passport required");
    if (!opts.idempotencyKey) throw new Error("idempotencyKey required");
    const cfg: GatewayConfig = {
      baseUrl: resolveBaseUrl(opts.baseUrl),
      timeoutMs: SETTLE_TIMEOUT_MS,
      fetchImpl: opts.fetch ?? fetch,
    };
    return postSettle(cfg, opts.passport, {
      paymentRequirements: opts.paymentRequirements,
      paymentPayload: opts.paymentPayload,
      idempotencyKey: opts.idempotencyKey,
      ...(opts.reservationId ? { reservationId: opts.reservationId } : {}),
    });
  }

  /**
   * Enforce screen decision: allow continues; everything else throws.
   * insufficient_data is not a silent allow.
   */
  static assertScreenAllow(out: ScreenResult): void {
    if (out.decision === "allow") return;
    if (out.decision === "review") throw new Error("screen_review");
    if (out.decision === "deny") throw new Error("screen_deny");
    throw new Error("screen_insufficient_data");
  }
}

export const TRUST_NETWORK_CONSENT_SUMMARY =
  "Free WardPass hosting is a blunt trade: Trust Network membership. Aggregated/de-identified signals feed /v1/screen and may go to selected underwriting evaluation partners. At low participant counts, aggregated signals may still be attributable to specific operators. TN is not a trust seal.";
