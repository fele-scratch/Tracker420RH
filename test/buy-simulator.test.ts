import assert from "node:assert/strict";
import test from "node:test";
import { buildGmgnUnsignedBuy } from "../src/gmgn-buy.js";
import { buildPonsBuyTransaction, buildUnsignedBuyTransaction, calculateMinimumOutput, encodePonsBuyCalldata, PONS_BUY_SELECTOR, ROBINHOOD_CHAIN_ID, SIMULATED_BUY_AMOUNT_WEI, simulateFastBuy } from "../src/buy-simulator.js";

const TOKEN = "0xec2009c8ce54bbbb4f0166c9bf8b03e8a3c0caf2";
const ROUTE = {
  chainId: ROBINHOOD_CHAIN_ID,
  inputToken: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  outputToken: TOKEN,
  amountInWei: SIMULATED_BUY_AMOUNT_WEI,
  minAmountOut: 900n,
  recipient: "0x1111111111111111111111111111111111111111",
  deadline: 2_000_000_000,
  to: "0x8876789976decbfcbbbe364623c63652db8c0904",
  data: "0x12345678abcdef",
  valueWei: SIMULATED_BUY_AMOUNT_WEI,
  gasLimit: 250_000n,
  maxFeePerGas: 1_000_000_000n,
  maxPriorityFeePerGas: 100_000_000n,
  nonce: 7,
} as const;

test("maps a GMGN Robinhood route and simulation into an unsigned transaction", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Request[] = [];
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    if (request.method === "GET") {
      return new Response(JSON.stringify({ code: 0, data: { chain_id: 4663, to: ROUTE.to, amount_in: SIMULATED_BUY_AMOUNT_WEI.toString(), amount_out: "1000", input_token_address: "0x0000000000000000000000000000000000000000", output_token_address: TOKEN, value: SIMULATED_BUY_AMOUNT_WEI.toString() } }), { status: 200 });
    }
    return new Response(JSON.stringify({ code: 0, data: { chainId: 4663, to: ROUTE.to, data: ROUTE.data, value: SIMULATED_BUY_AMOUNT_WEI.toString(), gas_limit: "250000", nonce: 7, max_fee_per_gas: "1000000000", max_priority_fee_per_gas: "100000000" } }), { status: 200 });
  };
  try {
    const plan = await buildGmgnUnsignedBuy({ apiKey: "test-key", tokenAddress: TOKEN, recipient: ROUTE.recipient, amountInWei: SIMULATED_BUY_AMOUNT_WEI, slippagePercent: 15, apiBaseUrl: "https://gmgn.test" });
    assert.equal(plan.transaction.chainId, 4663);
    assert.equal(plan.transaction.to, ROUTE.to);
    assert.equal(plan.transaction.value, SIMULATED_BUY_AMOUNT_WEI);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].headers.get("x-route-key"), "test-key");
    assert.match(requests[0].url, /token_in_chain=robinhood/);
    assert.match(requests[0].url, /token_in_address=0x0000000000000000000000000000000000000000/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("builds a validated unsigned Robinhood BUY transaction", () => {
  const transaction = buildUnsignedBuyTransaction(ROUTE, 1_900_000_000);
  assert.deepEqual(transaction, {
    chainId: 4663,
    nonce: 7,
    to: ROUTE.to,
    data: ROUTE.data,
    value: SIMULATED_BUY_AMOUNT_WEI,
    gasLimit: 250_000n,
    maxFeePerGas: 1_000_000_000n,
    maxPriorityFeePerGas: 100_000_000n,
    type: "eip1559",
  });
});

test("rejects a route for the wrong chain", () => {
  assert.throws(() => buildUnsignedBuyTransaction({ ...ROUTE, chainId: 1 }, 1_900_000_000), /Unsupported chain ID/);
});

test("rejects expired or mismatched native value", () => {
  assert.throws(() => buildUnsignedBuyTransaction({ ...ROUTE, deadline: 1_900_000_000 }, 1_900_000_000), /deadline has expired/);
  assert.throws(() => buildUnsignedBuyTransaction({ ...ROUTE, valueWei: 1n }, 1_900_000_000), /value must equal input amount/);
});

test("encodes the researched direct Pons buy calldata", () => {
  const recipient = ROUTE.recipient;
  const calldata = encodePonsBuyCalldata(SIMULATED_BUY_AMOUNT_WEI, 0n, recipient);
  assert.equal(calldata.length, 202);
  assert.equal(calldata.slice(0, 10), PONS_BUY_SELECTOR);
  assert.equal(calldata.slice(-40), recipient.slice(2));
  assert.equal(calldata.slice(10 + 64, 10 + 128), "0".repeat(64));
});

test("builds a direct Pons pool transaction from a supplied pool", () => {
  const transaction = buildPonsBuyTransaction({
    chainId: ROBINHOOD_CHAIN_ID,
    inputToken: ROUTE.inputToken,
    tokenAddress: TOKEN,
    amountInWei: SIMULATED_BUY_AMOUNT_WEI,
    amountOutMinimum: 0n,
    recipient: ROUTE.recipient,
    deadline: ROUTE.deadline,
    poolAddress: ROUTE.to,
    gasLimit: ROUTE.gasLimit,
    maxFeePerGas: ROUTE.maxFeePerGas,
    maxPriorityFeePerGas: ROUTE.maxPriorityFeePerGas,
    nonce: ROUTE.nonce,
  }, 1_900_000_000);
  assert.equal(transaction.to, ROUTE.to);
  assert.equal(transaction.value, SIMULATED_BUY_AMOUNT_WEI);
  assert.match(transaction.data, /^0x59a87bc1/);
});

test("calculates explicit slippage policy without changing historical zero policy", () => {
  assert.equal(calculateMinimumOutput("zero", undefined, 1_500n), 0n);
  assert.equal(calculateMinimumOutput("slippage", 1_001n, 1_500n), 850n);
});

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
