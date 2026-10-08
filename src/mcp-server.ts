import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  loadConfig,
  lookupWallet,
  screenOutbound,
  settlePayment,
  GatewayFailure,
  type FetchLike,
  type Env,
} from "./gateway.js";

export const WARDPASS_EDGE_VERSION = "0.2.0";

const APPROVAL_INSTRUCTION =
  "A human must approve this payment in Telegram or the WardPass console. Do not retry with a new idempotencyKey, do not split it into smaller payments, and do not try another route. After approval the gateway completes it.";

const AWAITING_INSTRUCTION =
  "This payment is waiting on human approval in Telegram or the WardPass console. Retry later with the same idempotency key. Do not invent a new one, do not split the payment, and do not try another route.";

const OUTCOME_UNKNOWN_MESSAGE = "Do not pay again. Retry only with the SAME idempotencyKey.";

const ALLOW_CAVEAT =
  "allow means WardPass found no reason to stop this payment. It is not a guarantee. insufficient_data is not an allow.";

const atomicAmount = z
  .string()
  .regex(/^[0-9]{1,30}$/)
  .refine((value) => {
    try {
      return BigInt(value) > 0n;
    } catch {
      return false;
    }
  }, "amount must be greater than 0");

const payTo = z.string().regex(/^\S{1,128}$/);
const network = z.string().regex(/^[a-z0-9:_-]{1,64}$/i);

const checkWalletInput = z
  .object({
    address: z
      .string()
      .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
      .describe("Solana wallet address in base58 (32–44 characters, no 0, O, I, or l)."),
  })
  .strict();

const screenPaymentInput = z
  .object({
    agentId: z
      .string()
      .regex(/^\S{1,128}$/)
      .optional()
      .describe("WardPass agent id (1–128 characters, no whitespace). Defaults to WARDPASS_AGENT_ID when you omit it."),
    payTo: payTo.describe("Who gets paid: a wallet address or a WardPass agent id (1–128 characters, no whitespace)."),
    amount: atomicAmount.describe("Amount in atomic units. A decimal integer string greater than zero, 1–30 digits."),
    asset: z.string().min(1).max(128).describe("Asset identifier, such as a mint or symbol (1–128 characters)."),
    network: network.describe("Network id, for example solana or solana:mainnet (letters, digits, colon, underscore, hyphen; 1–64)."),
    merchantId: z.string().min(1).max(128).optional().describe("Optional merchant id (1–128 characters)."),
  })
  .strict();

const paymentRequirementsInput = z
  .object({
    amount: atomicAmount.describe("Amount in atomic units. A decimal integer string greater than zero, 1–30 digits."),
    payTo: payTo.describe("Who gets paid: a wallet address or a WardPass agent id (1–128 characters, no whitespace)."),
    network: network.describe("Network id (letters, digits, colon, underscore, hyphen; 1–64)."),
    asset: z.string().min(1).max(128).describe("Asset identifier (1–128 characters)."),
    scheme: z.string().min(1).max(64).optional().describe("Optional x402 scheme, for example exact."),
    resource: z.string().min(1).max(2048).optional().describe("Optional x402 resource."),
    description: z.string().min(1).max(1024).optional().describe("Optional human-readable description."),
    mimeType: z.string().min(1).max(256).optional().describe("Optional MIME type."),
    maxTimeoutSeconds: z.number().int().nonnegative().max(604800).optional().describe("Optional x402 max timeout, in seconds."),
    maxAmountRequired: z.string().regex(/^[0-9]{1,30}$/).optional().describe("Optional x402 max amount in atomic units."),
    extra: z.object({}).passthrough().optional().describe("Optional extra x402 object. Passed through."),
  })
  .strict();

const settlePaymentInput = z
  .object({
    paymentRequirements: paymentRequirementsInput.describe(
      "x402 payment requirements. Required: amount, payTo, network, asset. Unknown keys are rejected."
    ),
    paymentPayload: z
      .object({})
      .passthrough()
      .describe(
        "Signed x402 payment payload from your x402 client. Passed through untouched. This field is not strict: unknown keys are kept."
      ),
    idempotencyKey: z
      .string()
      .regex(/^[A-Za-z0-9._:-]{8,128}$/)
      .describe(
        "Idempotency key for this settle (8–128 characters: letters, digits, dot, underscore, colon, hyphen). If the outcome is unknown, retry with this same key. Do not invent a new one."
      ),
    reservationId: z
      .string()
      .trim()
      .regex(/^\S{1,200}$/)
      .optional()
      .describe(
        "Optional reservation id from a gateway reserve or approval response. When you pass it, settle uses that hold. If that hold is refused, do not retry with a new idempotency key."
      ),
  })
  .strict();

type ToolContent = { type: "text"; text: string };

type ToolResult = {
  content: ToolContent[];
  structuredContent: Record<string, unknown>;
  isError?: boolean;
};

export function createWardPassMcpServer(opts: { env?: Env; fetch?: FetchLike } = {}): McpServer {
  const env = opts.env ?? process.env;
  const cfg = loadConfig(env, opts.fetch ?? fetch);
  const secrets = [cfg.apiKey, cfg.passport].filter((value): value is string => Boolean(value));

  const server = new McpServer({
    name: "wardpass-edge",
    version: WARDPASS_EDGE_VERSION,
  });

  server.registerTool(
    "wardpass_check_wallet",
    {
      description:
        "Look up public signals for one Solana wallet (age, funding, how often it transacts). Read-only. The text ends with the gateway advisory. Signals, not a guarantee. This tool does not say whether a payment should proceed.",
      inputSchema: checkWalletInput,
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const body = await lookupWallet(cfg, args.address);
        const advisory = typeof body.advisory === "string" ? body.advisory : "Signals, not a guarantee.";
        return ok(`Wallet ${args.address}. ${advisory}`, body, secrets);
      } catch (err) {
        return fromFailure(err, secrets);
      }
    }
  );

  server.registerTool(
    "wardpass_screen_payment",
    {
      description:
        `Screen an outbound payment before you settle it. Needs WARDPASS_KEY, an operator key (abok_…). ${ALLOW_CAVEAT}`,
      inputSchema: screenPaymentInput,
    },
    async (args) => {
      if (!cfg.apiKey) {
        return fail(
          "missing_key",
          "WARDPASS_KEY is not set. Get a free operator key from POST /v1/signup, or from the WardPass console.",
          secrets
        );
      }
      const agentId = args.agentId ?? cfg.agentId;
      if (!agentId) {
        return fail("missing_agent_id", "Pass agentId, or set WARDPASS_AGENT_ID.", secrets);
      }
      const payload: Record<string, unknown> = {
        agentId,
        payTo: args.payTo,
        amount: args.amount,
        asset: args.asset,
        network: args.network,
      };
      if (args.merchantId !== undefined) payload.merchantId = args.merchantId;
      try {
        const body = await screenOutbound(cfg, cfg.apiKey, payload);
        const decision = body.decision ?? null;
        const confidence = body.confidence ?? null;
        const reasons = Array.isArray(body.reasons)
          ? body.reasons
          : Array.isArray(body.factors)
            ? body.factors
            : [];
        const structured: Record<string, unknown> = {
          decision,
          confidence,
          reasons,
          screenId: body.screenId ?? null,
        };
        if (body.factors !== undefined) structured.factors = body.factors;
        const decisionText = typeof decision === "string" ? decision : "unknown";
        const confidenceText = confidence == null ? "unknown" : String(confidence);
        return ok(`${decisionText} (${confidenceText}). ${ALLOW_CAVEAT}`, structured, secrets);
      } catch (err) {
        return fromFailure(err, secrets);
      }
    }
  );

  server.registerTool(
    "wardpass_settle_payment",
    {
      description:
        "Settle a payment under the agent's Policy Passport (WARDPASS_PASSPORT). This moves money. Caps and human approval are enforced by WardPass. Splitting a payment to get under an approval threshold is not allowed. If you have a reservationId from reserve or from an approval, pass it and WardPass settles that hold. If the status is approval_required, stop and wait for a human. Do not retry with a new idempotency key. If the status is awaiting_approval, the payment is waiting on that human. Retry later with the same idempotency key. A refused hold is final: do not retry that with a new idempotency key. If the status is outcome_unknown, retry only with the same idempotency key.",
      inputSchema: settlePaymentInput,
      annotations: { destructiveHint: true, readOnlyHint: false },
    },
    async (args) => {
      if (!cfg.passport) {
        return fail(
          "missing_passport",
          "WARDPASS_PASSPORT is not set. Issue a Policy Passport for this agent in the WardPass console.",
          secrets
        );
      }
      const result = await settlePayment(cfg, cfg.passport, {
        paymentRequirements: args.paymentRequirements as Record<string, unknown>,
        paymentPayload: args.paymentPayload as Record<string, unknown>,
        idempotencyKey: args.idempotencyKey,
        ...(args.reservationId ? { reservationId: args.reservationId } : {}),
      });
      return formatSettle(result, secrets);
    }
  );

  return server;
}

export function startupLine(env: Env): string {
  const key = nonemptyEnv(env.WARDPASS_KEY) ? "set" : "not set";
  const passport = nonemptyEnv(env.WARDPASS_PASSPORT) ? "set" : "not set";
  return `wardpass-edge-mcp ${WARDPASS_EDGE_VERSION} ready (key: ${key}, passport: ${passport})`;
}

function nonemptyEnv(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function reservationField(reservationId: string | undefined): { reservationId?: string } {
  return reservationId ? { reservationId } : {};
}

function unknownMessage(retryAfterMs: number | undefined): string {
  if (retryAfterMs == null || retryAfterMs <= 0) return OUTCOME_UNKNOWN_MESSAGE;
  return `${OUTCOME_UNKNOWN_MESSAGE} Wait at least ${retryAfterMs}ms before you retry.`;
}

function formatSettle(
  result: Awaited<ReturnType<typeof settlePayment>>,
  secrets: string[]
): ToolResult {
  switch (result.type) {
    case "settled":
      return ok("settled", { status: "settled", ...result.fields }, secrets);
    case "approval_required":
      return ok(`approval_required. ${APPROVAL_INSTRUCTION}`, {
        status: "approval_required",
        approvalId: result.approvalId ?? null,
        expiresAt: result.expiresAt ?? null,
        ...reservationField(result.reservationId),
        instruction: APPROVAL_INSTRUCTION,
      }, secrets);
    case "awaiting_approval":
      return ok(`awaiting_approval. ${AWAITING_INSTRUCTION}`, {
        status: "awaiting_approval",
        approvalId: result.approvalId ?? null,
        expiresAt: result.expiresAt ?? null,
        ...reservationField(result.reservationId),
        instruction: AWAITING_INSTRUCTION,
      }, secrets);
    case "outcome_unknown":
      return fail(result.code, unknownMessage(result.retryAfterMs), secrets, {
        status: "outcome_unknown",
        ...(result.retryAfterMs != null ? { retryAfterMs: result.retryAfterMs } : {}),
      });
    case "denied":
      return ok(`denied: ${result.errorReason}`, {
        status: "denied",
        errorReason: result.errorReason,
      }, secrets);
    case "error":
      return fail(result.code, result.message, secrets);
    default:
      return fail("internal_error", "the tool failed", secrets);
  }
}

function fromFailure(err: unknown, secrets: string[]): ToolResult {
  if (err instanceof GatewayFailure) return fail(err.code, err.message, secrets);
  return fail("internal_error", "the tool failed", secrets);
}

function ok(text: string, structured: Record<string, unknown>, secrets: string[]): ToolResult {
  const safe = redact({ text, structured }, secrets);
  return {
    content: [{ type: "text", text: safe.text }],
    structuredContent: safe.structured,
  };
}

function fail(
  code: string,
  message: string,
  secrets: string[],
  extra?: Record<string, unknown>
): ToolResult {
  const safe = redact({ code, message, extra: extra ?? {} }, secrets);
  return {
    isError: true,
    content: [{ type: "text", text: `${safe.code}: ${safe.message}` }],
    structuredContent: {
      code: safe.code,
      message: safe.message,
      ...safe.extra,
    },
  };
}

function redact<T>(value: T, secrets: string[]): T {
  const needles = secrets.filter((secret) => secret.length >= 8);
  if (needles.length === 0) return value;
  let json = JSON.stringify(value);
  for (const secret of needles) {
    json = json.split(secret).join("[redacted]");
    const escaped = JSON.stringify(secret).slice(1, -1);
    if (escaped !== secret) json = json.split(escaped).join("[redacted]");
  }
  return JSON.parse(json) as T;
}
