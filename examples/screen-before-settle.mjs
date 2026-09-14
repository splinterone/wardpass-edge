/**
 * Example: receiver checks WardPass /v1/screen before settle.
 * WARDPASS_URL defaults to staging https://wardpass-gateway-staging.fly.dev
 * (Fly.dev hostname, not a production custom domain).
 * Set WARDPASS_RECEIVER_KEY (abrk_… from hosted bootstrap/pilot).
 */
import { WardPassClient } from "../dist/index.js";

const STAGING_URL = "https://wardpass-gateway-staging.fly.dev";
const baseUrl = process.env.WARDPASS_URL || STAGING_URL;
const receiverApiKey = process.env.WARDPASS_RECEIVER_KEY;
if (!receiverApiKey) {
  console.error("Set WARDPASS_RECEIVER_KEY (optional WARDPASS_URL, defaults to staging)");
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
