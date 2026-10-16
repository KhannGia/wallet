// The verifier lives in the shared package, so the browser checks a proof with
// exactly the code ./wallet verify-proof runs.
export { verifyAgainstRegistry, type Verdict } from "@wallet/shared";
