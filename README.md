# wardpass-edge

**WardPass** is a **free hosted control plane** (policy gateway) for agent payments — **one seat**:

- Operator account and API key
- Create / kill **1 agent**
- **Policy Passports** for scoped spend
- **Reserve → settle** through *your* facilitator(s)
- Oversight heartbeat (“I’m watching”) — a **dead-man’s switch** on new spend
- **Admin console** (operator `/admin` API)
- **Clearance / `POST /v1/screen`:** Trust Network + live oversight + known agent. Screen before irreversible settle

Install [`wardpass-edge`](https://www.npmjs.com/package/wardpass-edge) and point `WARDPASS_URL` at hosted WardPass.

This repo is **not** a self-hosted gateway and **not** the AgentBound monorepo. The control plane, ledger, Trust Network, and `/v1/screen` bureau stay on **WardPass hosted**.

## Install

Requires Node.js 18 or newer.

```bash
npm i wardpass-edge
```

Package: [wardpass-edge on npm](https://www.npmjs.com/package/wardpass-edge).

### From source

```bash
git clone https://github.com/splinterone/wardpass-edge.git
cd wardpass-edge
npm install
npm run build
```

## Why this exists

**Free hosted control plane**: one operator seat with passports, reserve→settle, oversight, and an admin API — without forking a gateway.

Trust Network membership is **mandatory** on that seat so the clearance bureau has density. If you're taking agent payments, settle is irreversible — `POST /v1/screen` only works if enough operators are live, consented, and visible.

v0 is honest: `/v1/screen` never returns `confidence: high`. `insufficient_data` is first-class, not a silent allow.

## Quick start

### 1. Configure

```bash
export WARDPASS_URL=https://wardpass-gateway-staging.fly.dev
export WARDPASS_KEY=abok_…                         # operator key from POST /v1/signup
export WARDPASS_RECEIVER_KEY=abrk_…                # receiver key for /v1/screen (invite-only)
```

The `*.fly.dev` hostname is where hosted WardPass runs today. It is not a production custom domain. `curl "$WARDPASS_URL/health"` should return `{"status":"ok","mode":"gateway"}`. The free tier is one seat (`maxAgents: 1`). Extra seats are a later upsell.

### 2. Phone home (operators)

`WardPassClient` holds the operator key (`baseUrl`, `apiKey`, optional `operatorId`). It does **not** wrap control-plane routes as instance methods — those stay on the hosted API. Receiver helpers are `screenBeforeSettle` and `assertScreenAllow` (step 3). `settlePayment` is the settle helper: pass `reservationId` when you already have a hold.

Signup (Trust Network consent is required; see [CONSENT.md](./CONSENT.md)):

```js
const baseUrl = process.env.WARDPASS_URL || "https://wardpass-gateway-staging.fly.dev";

const plan = await fetch(`${baseUrl}/v1/signup`).then((r) => r.json());
// { plan: "free", maxAgents: 1, acceptField: "acceptTrustNetworkConsent", ... }

const { operatorId, apiKey } = await fetch(`${baseUrl}/v1/signup`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ acceptTrustNetworkConsent: true }),
}).then((r) => r.json());
// apiKey is abok_… — set WARDPASS_KEY to this
```

Then call hosted `/admin/*` with that key. Using the client only for credentials:

```js
import { WardPassClient } from "wardpass-edge";

const wp = new WardPassClient({
  baseUrl: process.env.WARDPASS_URL || "https://wardpass-gateway-staging.fly.dev",
  apiKey: process.env.WARDPASS_KEY, // abok_…
});

const headers = {
  authorization: `Bearer ${wp.apiKey}`,
  "content-type": "application/json",
};

const created = await fetch(`${wp.baseUrl}/admin/agents`, {
  method: "POST",
  headers,
  body: JSON.stringify({ displayName: "pilot" }),
}).then((r) => r.json());
// { agentId } or { error: "agent_limit_reached", plan: "free", maxAgents: 1 }

const { agents } = await fetch(`${wp.baseUrl}/admin/agents`, { headers }).then((r) => r.json());

await fetch(`${wp.baseUrl}/admin/agents/${created.agentId}/passports`, {
  method: "POST",
  headers,
  body: JSON.stringify({ policy: { /* spend-cap object */ } }),
});
// Hosted errors: policy_missing | invalid_cap_shape

// Reserve → settle is hosted policy + *your* facilitator(s).
// Hosted WardPass also exposes x402 POST /verify and POST /settle
// (paymentPayload + paymentRequirements). Pass reservationId to
// WardPassClient.settlePayment when you have a hold. /verify stays
// on the hosted API.

await fetch(`${wp.baseUrl}/admin/agents/${created.agentId}/kill`, {
  method: "POST",
  headers,
  body: JSON.stringify({}),
});
```

Other operator routes (same Bearer token): `GET`/`POST /admin/api-keys`, `POST /admin/api-keys/:id/revoke`, `GET /admin/approvals`, `GET /admin/screens`. Oversight heartbeat is hosted (dead-man on new spend); `/v1/screen` **allow** still requires it live.

### 3. Screen before settle (receivers)

```bash
node examples/screen-before-settle.mjs
```

Or in your settle path:

```js
import { WardPassClient } from "wardpass-edge";

const out = await WardPassClient.screenBeforeSettle({
  baseUrl: process.env.WARDPASS_URL || "https://wardpass-gateway-staging.fly.dev",
  receiverApiKey: process.env.WARDPASS_RECEIVER_KEY, // abrk_…
  body: { agentId, amount, asset, payTo, network },
});

WardPassClient.assertScreenAllow(out); // throws on review | deny | insufficient_data
// … then call your facilitator settle …
```

`allow` still requires a known agent, a valid passport where applicable, and **live** oversight. Trust Network membership is not a trust seal.

## Free tier trade

Free control plane ↔ **mandatory Trust Network** membership. That is the blunt deal: you get hosting; the bureau gets density.

- Aggregated / de-identified signals feed receiving-side **`/v1/screen`**
- The same class of telemetry may be shared with **selected insurance / certification / underwriting evaluation partners**
- At low participant counts, aggregated signals may still be attributable to specific operators
- Leave TN → stop new contribution **and** lose free hosted eligibility

Full text: [CONSENT.md](./CONSENT.md).

## Not a full gateway

| This OSS repo | WardPass hosted (private product) |
| --- | --- |
| TypeScript client + screen helper (`screenBeforeSettle`, `assertScreenAllow`) | Control plane, hash-chained ledger, Trust Network, `POST /v1/screen` bureau |
| Apache-2.0 phone-home to `/v1/signup` and `/admin/*` | Operator seats, Policy Passports, reserve/settle, oversight heartbeat, admin console |
| `npm i wardpass-edge` | **Not** the AgentBound monorepo — that stays private |

You can point this client at your own DIY settle path without WardPass hosting. You just will not get the free control plane.

## Names

| Name | Role |
| --- | --- |
| **WardPass** | Company + public product (hosted control plane for operators + `/screen` for receivers) |
| **AgentBound** | Private engineering monorepo / interim codename |
| **wardpass-edge** | This public OSS client |

## Use it from Claude Desktop or Cursor (MCP)

0.2.0 adds a stdio server, `wardpass-edge-mcp`. It calls hosted WardPass. It does not approve payments for you.

- `wardpass_check_wallet` looks up public signals for a Solana address. No key.
- `wardpass_screen_payment` screens an outbound payment. Set `WARDPASS_KEY` (operator key, `abok_…`).
- `wardpass_settle_payment` settles under the agent's Policy Passport. Set `WARDPASS_PASSPORT`. This moves money. If you have a `reservationId` from reserve or from an approval, pass it. WardPass settles that hold, or refuses it.

`allow` means WardPass found no reason to stop this payment. It is not a guarantee. `insufficient_data` is not an allow.

`approval_required` means a human approves that payment in Telegram or the WardPass console. Stop there. Do not retry it with a new idempotency key, do not split it, and do not try another route.

`awaiting_approval` means that approval is still pending on the hold. Retry later with the same idempotency key. The gateway returns the same approval id while it is waiting. Do not invent a new key.

A refused hold is final. That is already settled, released, expired, not open, a different passport, a hold already tied to another payment, an amount above or below the hold, or another agent's hold (`reservation_agent_mismatch`). An unknown reservation id is HTTP 404 `reservation_not_found`, and that is final too, not a dropped connection. A later gateway may use that same 404 for another agent's id. Do not retry any of these with a new idempotency key. `outcome_unknown` is the other case: the facilitator timed out (`settlement_unknown`), or the gateway sent a 409 this client does not recognize. Retry only with the same idempotency key, and do not pay again. If that body includes `retryAfterMs`, wait at least that long. A screening miss or a per-payment cap refusal still comes back as a normal denial, not as an unknown outcome.

The same settle is on `WardPassClient.settlePayment`. `reservationId` is optional there too. Leave it out when you do not have a hold id.

```js
import { WardPassClient } from "wardpass-edge";

const settled = await WardPassClient.settlePayment({
  baseUrl: process.env.WARDPASS_URL,
  passport: process.env.WARDPASS_PASSPORT,
  paymentRequirements,
  paymentPayload,
  idempotencyKey,
  reservationId,
});
```

Until 0.2.0 is on npm, point `command` at `node` and `args` at the built `dist/mcp.js` from a clone (`npm install`, then `npm run build`). After publish, the `npx` command below works. Keep keys out of shared repos. Put the config in your user-level file.

Claude Desktop, `claude_desktop_config.json`:

```json
{"mcpServers":{"wardpass":{"command":"npx","args":["-y","wardpass-edge-mcp"],"env":{"WARDPASS_KEY":"abok_…","WARDPASS_PASSPORT":"…"}}}}
```

From a clone, before it is on npm:

```json
{"mcpServers":{"wardpass":{"command":"node","args":["/absolute/path/to/wardpass-edge/dist/mcp.js"],"env":{"WARDPASS_KEY":"abok_…","WARDPASS_PASSPORT":"…"}}}}
```

Cursor uses the same shape in `.cursor/mcp.json`, or in `~/.cursor/mcp.json` if the config is just for you. Use the user file so the key and passport stay out of the repo.

`WARDPASS_AGENT_ID` is an optional default agent id for the screen tool. `WARDPASS_URL` overrides the hosted WardPass base URL.

## Status

**wardpass-edge@0.2.0** adds the MCP server and is not on npm yet. **wardpass-edge@0.1.1** is on npm: [`wardpass-edge`](https://www.npmjs.com/package/wardpass-edge). Hosted WardPass is live at `https://wardpass-gateway-staging.fly.dev` (Fly.dev hostname, not a production custom domain). Point `WARDPASS_URL` at it.

Apache-2.0. Product backend remains proprietary.
