# Changelog

## 0.2.0

0.2.0 is not on npm yet. The published package is still 0.1.1, so these notes stay on this version instead of a new one.

- stdio MCP server `wardpass-edge-mcp`, with `wardpass_check_wallet`, `wardpass_screen_payment`, and `wardpass_settle_payment`.
- You can pass an optional `reservationId` into `wardpass_settle_payment` and into `WardPassClient.settlePayment`. When you do, settle sends that hold to the gateway.
- Settle reads a 409 by its code. `settlement_unknown`, a missing code, or a code this client does not recognize still means the outcome is unknown: retry only with the same idempotency key. These codes are a finished refusal, so you do not retry them with a new idempotency key: `reservation_already_settled`, `reservation_passport_mismatch`, `reservation_bound_to_other_payment`, `amount_exceeds_hold`, `amount_below_hold`, `reservation_owner_mismatch`, `reservation_expired`, and `reservation_not_found`. Close names for the wrong owner and an unknown id are treated the same way.
