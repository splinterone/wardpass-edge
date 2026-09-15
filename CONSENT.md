# Trust Network consent (free hosted tier)

The free WardPass control plane is a **blunt trade**: you get hosting; the bureau gets density.

WardPass’s free hosted control-plane tier requires **Trust Network** membership.

By joining, you agree that WardPass may:

1. Use **aggregated or de-identified** fleet and payment-path signals from your operators/agents to power receiving-side **`POST /v1/screen`** decisions for merchants and facilitators.
2. Share **aggregated or de-identified** payment-path and screen telemetry with **selected insurance, certification, or underwriting evaluation partners**, solely for risk-model diligence and partnership evaluation — not as a lead list of identifiable operators.

At low participant counts, aggregated signals may still be attributable to specific operators.

You can leave Trust Network at any time. Leaving **stops new contribution**; membership/audit timestamps may be retained. Leaving also ends eligibility for the **free** hosted tier (you may still use this OSS edge against your own DIY settle path without WardPass hosting). Extra agent seats are a later upsell; they are not part of the free TN-backed control plane.

**Trust Network membership is not a trust seal.** `/v1/screen` allow still requires a known agent, valid passport where applicable, and **live** operator oversight. Confidence is never `high` in v0; `insufficient_data` is a first-class outcome, not a silent allow.

This file is product copy for the signup wall. It is not a substitute for a formal DPA or terms of service once the company is incorporated.
