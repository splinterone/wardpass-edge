# wardpass-edge

Thin **open-source client** for [WardPass](https://github.com/splinterone) — the hosted pre-settle trust layer for irreversible agent payments.

> **This is not the full gateway.** The control plane, hash-chained ledger, Trust Network, and `POST /v1/screen` bureau stay on **WardPass hosted** (private product). This package phones home.

## Company vs codenames

| Name | Role |
| --- | --- |
| **WardPass** | Company + public product (gateway for operators + `/screen` for receivers) |
| **AgentBound** | Private engineering monorepo / interim codename |
| **wardpass-edge** | This public OSS client |

## Free hosted tier ↔ Trust Network

Free WardPass hosting requires **Trust Network** membership under blunt consent:

1. Aggregated / de-identified signals feed receiving-side **`/v1/screen`**
2. Same class of telemetry may be shared with **selected insurance / certification / underwriting evaluation partners**
3. Leave TN → stop new contribution and lose free hosted eligibility

See [CONSENT.md](./CONSENT.md).

**Trust Network is not a trust seal.** `/v1/screen` **allow** still needs a known agent, valid passport where applicable, and **live** oversight. v0 never returns `confidence: high`. `insufficient_data` is not a silent allow.

## Install

```bash
npm install wardpass-edge   # when published
# or: clone and npm run build
```

## Receiver: screen before settle

```js
import { WardPassClient } from "wardpass-edge";

const out = await WardPassClient.screenBeforeSettle({
  baseUrl: process.env.WARDPASS_URL,
  receiverApiKey: process.env.WARDPASS_RECEIVER_KEY, // abrk_…
  body: { agentId, amount, asset, payTo, network },
});

WardPassClient.assertScreenAllow(out); // throws on review | deny | insufficient_data
// … then call your facilitator settle …
```

## Status

Scaffold for the free↔TN cold start. Hosted signup URL and npm publish land as WardPass staging comes up.

Apache-2.0. Product backend remains proprietary.
