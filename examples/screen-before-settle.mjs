/**
 * Example: receiver checks WardPass /v1/screen before settle.
 * Set WARDPASS_URL + WARDPASS_RECEIVER_KEY (abrk_… from hosted bootstrap/pilot).
 */
import { WardPassClient } from "../dist/index.js";

const baseUrl = process.env.WARDPASS_URL;
const receiverApiKey = process.env.WARDPASS_RECEIVER_KEY;
if (!baseUrl || !receiverApiKey) {
  console.error("Set WARDPASS_URL and WARDPASS_RECEIVER_KEY");
  process.exit(1);
}

const out = await WardPassClient.screenBeforeSettle({
  baseUrl,
  receiverApiKey,
  body: {
    agentId: process.env.AGENT_ID || "demo-agent",
    amount: "1000000",
    asset: "USDC",
  },
});

console.log(out);
WardPassClient.assertScreenAllow(out);
console.log("allow — safe to continue settle path");
