/**
 * wardpass-edge — thin client for WardPass hosted API.
 * Does not implement the full gateway. Phone-home only.
 */

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
  /** Hosted API base, e.g. https://api.wardpass.example */
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
  "Free WardPass hosting requires Trust Network: signals feed /v1/screen and may be shared (aggregated/de-identified) with selected underwriting evaluation partners. TN is not a trust seal.";
