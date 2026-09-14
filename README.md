# wardpass-edge

**WardPass** gives builders a hosted policy gateway for agent payments — **free** for one seat:

- Operator account and **1 agent seat**
- **Policy Passports** for scoped spend
- **Reserve / settle** through *your* facilitator(s)
- Oversight heartbeat (“I’m watching”) — a **dead-man’s switch** on new spend
- **Clearance network**: when you are on the Trust Network *and* oversight is live, receivers can `POST /v1/screen` before irreversible settle

This repo is the thin open-source **phone-home client**. Clone it, point `WARDPASS_URL` at the live staging gateway, and you are on the bureau.

It is **not** a self-hosted gateway. It is **not** the AgentBound monorepo. The control plane, ledger, Trust Network, and `/v1/screen` bureau stay on **WardPass hosted**.

## Why this exists

Receivers take the irreversible-settle risk. Screening only works if enough operators are live, consented, and visible. This client is how you plug in in minutes — densifying the clearance bureau for everyone who screens before they settle.

v0 is honest: `/v1/screen` never returns `confidence: high`. `insufficient_data` is first-class, not a silent allow.

## Quick start

### 1. Install

```bash
git clone https://github.com/splinterone/wardpass-edge.git
cd wardpass-edge
npm install
npm run build
```

When published: `npm install wardpass-edge`.

### 2. Configure

```bash
export WARDPASS_URL=https://wardpass-gateway-staging.fly.dev
export WARDPASS_KEY=wpk_…                          # operator key (phone-home)
export WARDPASS_RECEIVER_KEY=abrk_…                # receiver key for /v1/screen
```

That host is **staging** (`*.fly.dev`), not a production custom domain. `curl "$WARDPASS_URL/health"` should return `{"status":"ok","mode":"gateway"}`. Free tier = one seat; extra seats are a later upsell.

### 3. Phone home (operators)

Use your operator key against the hosted control plane. This package authenticates; it does not reimplement passports, reserve/settle, or the heartbeat.

```js
import { WardPassClient } from "wardpass-edge";

const wp = new WardPassClient({
  baseUrl: process.env.WARDPASS_URL || "https://wardpass-gateway-staging.fly.dev",
  apiKey: process.env.WARDPASS_KEY,
});
// Ready: Policy Passports, reserve/settle, and oversight heartbeat
// are hosted routes. Call them with this client’s credentials — don’t fork a gateway.
```

### 4. Screen before settle (receivers)

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
- Leave TN → stop new contribution **and** lose free hosted eligibility

Full text: [CONSENT.md](./CONSENT.md).

## Not a full gateway

| This OSS repo | WardPass hosted (private product) |
| --- | --- |
| Thin TypeScript client + screen helper | Control plane, hash-chained ledger, Trust Network, `POST /v1/screen` bureau |
| Apache-2.0 phone-home | Operator seats, Policy Passports, reserve/settle, oversight heartbeat |
| Clone and run | **Not** the AgentBound monorepo — that stays private |

You can point this client at your own DIY settle path without WardPass hosting. You just will not get the free control plane.

## Names

| Name | Role |
| --- | --- |
| **WardPass** | Company + public product (gateway for operators + `/screen` for receivers) |
| **AgentBound** | Private engineering monorepo / interim codename |
| **wardpass-edge** | This public OSS client |

## Status

Staging gateway is live at `https://wardpass-gateway-staging.fly.dev` (Fly.dev hostname, not a production custom domain). Point `WARDPASS_URL` at it. npm publish of this package is still pending — clone and `npm run build` until then.

Apache-2.0. Product backend remains proprietary.
