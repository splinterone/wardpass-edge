# Changelog

## 0.2.0

0.2.0 is not on npm yet. The published package is still 0.1.1, so these notes stay on this version instead of a new one.

- stdio MCP server `wardpass-edge-mcp`, with `wardpass_check_wallet`, `wardpass_screen_payment`, and `wardpass_settle_payment`.
- You can pass an optional `reservationId` into `wardpass_settle_payment` and into `WardPassClient.settlePayment`. When you do, settle sends that hold to the gateway.
- Settle reads the machine code from `code`, then `errorReason`, then `error`. `settlement_unknown`, a missing code, or a code this client does not recognize still means the outcome is unknown: retry only with the same idempotency key. When that body includes `retryAfterMs`, wait at least that long. `reservation_awaiting_approval` is pending human approval: retry later with the same idempotency key.
- These are finished refusals, so you do not retry them with a new idempotency key: `reservation_already_settled`, `reservation_released`, `reservation_expired`, `reservation_not_open`, `reservation_passport_mismatch`, `reservation_bound_to_other_payment`, `amount_exceeds_hold`, `amount_below_hold`, and `reservation_agent_mismatch` (all 409). An unknown reservation id is 404 `reservation_not_found`, which is also final.
