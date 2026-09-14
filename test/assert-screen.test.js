import { test } from "node:test";
import assert from "node:assert/strict";
import { WardPassClient } from "../dist/index.js";

test("assertScreenAllow only passes allow", () => {
  WardPassClient.assertScreenAllow({ decision: "allow" });
  assert.throws(() => WardPassClient.assertScreenAllow({ decision: "review" }), /screen_review/);
  assert.throws(() => WardPassClient.assertScreenAllow({ decision: "deny" }), /screen_deny/);
  assert.throws(
    () => WardPassClient.assertScreenAllow({ decision: "insufficient_data" }),
    /screen_insufficient_data/
  );
});
