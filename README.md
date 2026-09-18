# wardpass-edge

**WardPass** is a **free hosted control plane** (policy gateway) for agent payments — **one seat**:

- Operator account and API key
- Create / kill **1 agent**
- **Policy Passports** for scoped spend
- **Reserve → settle** through *your* facilitator(s)
- Oversight heartbeat (“I’m watching”) — a **dead-man’s switch** on new spend
- **Admin console** (operator `/admin` API)
- **Clearance / `POST /v1/screen`:** when you are on the Trust Network *and* oversight is live *and* the agent is known, receivers can screen before irreversible settle

Install [`wardpass-edge`](https://www.npmjs.com/package/wardpass-edge) and point `WARDPASS_URL` at the live staging gateway to phone home to that plane.

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

The signup hook is the **free hosted control plane**: one operator seat with passports, reserve→settle, oversight, and an admin API — without forking a gateway.

Trust Network membership is **mandatory** on that free seat so the clearance bureau has density. Receivers take the irreversible-settle risk; `POST /v1/screen` only works if enough operators are live, consented, and visible.

v0 is honest: `/v1/screen` never returns `confidence: high`. `insufficient_data` is first-class, not a silent allow.

## Quick start

### 1. Configure

```bash
export WARDPASS_URL=https://wardpass-gateway-staging.fly.dev
export WARDPASS_KEY=abok_…                         # operator key from POST /v1/signup
export WARDPASS_RECEIVER_KEY=abrk_…                # receiver key for /v1/screen (invite-only)
```

That host is **staging** (`*.fly.dev`), not a production custom domain. `curl "$WARDPASS_URL/health"` should return `{"status":"ok","mode":"gateway"}`. Free tier = one seat (`maxAgents: 1`); extra seats are a later upsell.

### 2. Phone home (operators)

`WardPassClient` holds the operator key (`baseUrl`, `apiKey`, optional `operatorId`). It does **not** wrap control-plane routes as instance methods — those stay on the hosted API. `screenBeforeSettle` / `assertScreenAllow` are the only client helpers (receivers, step 3).

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
// Staging also exposes x402 POST /verify and POST /settle
// (paymentPayload + paymentRequirements) — this client does not wrap them.

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

## Status

**wardpass-edge@0.1.1** is on npm: [`wardpass-edge`](https://www.npmjs.com/package/wardpass-edge). Staging gateway is live at `https://wardpass-gateway-staging.fly.dev` (Fly.dev hostname, not a production custom domain). Point `WARDPASS_URL` at it.

Apache-2.0. Product backend remains proprietary.
