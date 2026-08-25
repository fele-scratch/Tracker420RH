import assert from "node:assert/strict";
import test from "node:test";
import { SIMULATED_BUY_AMOUNT_WEI, simulateFastBuy } from "../src/buy-simulator.js";

const TOKEN = "0xec2009c8ce54bbbb4f0166c9bf8b03e8a3c0caf2";

test("simulates an immediate dry-run buy at 0.0008 ETH", () => {
  const result = simulateFastBuy(TOKEN, [{ accepted: true, expectedTokenOut: 1_000n, minTokenOut: 900n }]);
  assert.equal(result.mode, "DRY_RUN");
  assert.equal(result.success, true);
  assert.equal(result.amountWei, SIMULATED_BUY_AMOUNT_WEI);
  assert.equal(result.amountWei, 800_000_000_000_000n);
  assert.equal(result.attempts[0].elapsedMs, 0);
});

test("retries quickly after a simulated first rejection", () => {
  const result = simulateFastBuy(TOKEN, [
    { accepted: false, reason: "SIMULATED_NONCE_RACE" },
    { accepted: true, expectedTokenOut: 1_000n, minTokenOut: 950n },
  ], [0, 20]);
  assert.equal(result.success, true);
  assert.equal(result.attempts.length, 2);
  assert.deepEqual(result.attempts.map((item) => item.elapsedMs), [0, 20]);
  assert.equal(result.attempts[0].accepted, false);
  assert.equal(result.attempts[1].accepted, true);
});

test("does not simulate a buy when minimum output is not met", () => {
  const result = simulateFastBuy(TOKEN, [{ accepted: true, expectedTokenOut: 899n, minTokenOut: 900n }]);
  assert.equal(result.success, false);
  assert.equal(result.attempts[0].reason, "MIN_OUT_NOT_MET");
});

test("never produces a live execution action", () => {
  const result = simulateFastBuy(TOKEN, [{ accepted: true }]);
  assert.equal(result.mode, "DRY_RUN");
  assert.equal("txHash" in result, false);
  assert.equal("signedTransaction" in result, false);
});
