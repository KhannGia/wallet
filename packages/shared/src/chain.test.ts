import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { fromMinorUnits, toMinorUnits, USDC_DECIMALS } from "./chain.ts";

describe("minor unit conversion", () => {
  it("converts whole amounts", () => {
    assert.equal(toMinorUnits("100", USDC_DECIMALS), 100_000_000n);
  });

  it("converts fractional amounts", () => {
    assert.equal(toMinorUnits("1.5", USDC_DECIMALS), 1_500_000n);
    assert.equal(toMinorUnits("0.000001", USDC_DECIMALS), 1n);
  });

  it("rejects amounts with more precision than the token supports", () => {
    assert.throws(() => toMinorUnits("0.0000001", USDC_DECIMALS), /more precision/);
  });

  it("round-trips without losing value", () => {
    for (const amount of ["0", "1", "1.5", "0.000001", "123456.789012"]) {
      assert.equal(fromMinorUnits(toMinorUnits(amount, USDC_DECIMALS), USDC_DECIMALS), amount);
    }
  });

  it("handles negative amounts, which ledger entries need for debits", () => {
    assert.equal(fromMinorUnits(-1_500_000n, USDC_DECIMALS), "-1.5");
  });
});
