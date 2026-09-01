import assert from "node:assert/strict";
import crypto from "node:crypto";
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
    gasLimit: 250000n,
    maxFeePerGas: 1000000000n,
    maxPriorityFeePerGas: 100000000n,
    nonce: 7,
};
test("submits a signed GMGN Agent API Robinhood swap", async () => {
    const originalFetch = globalThis.fetch;
    const requests = [];
    const { privateKey } = crypto.generateKeyPairSync("ed25519");
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    globalThis.fetch = async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return new Response(JSON.stringify({ code: 0, data: { order_id: "test-order", status: "pending" } }), { status: 200 });
    };
    try {
        const plan = await buildGmgnUnsignedBuy({ apiKey: "test-key", privateKeyPem, tokenAddress: TOKEN, recipient: ROUTE.recipient, amountInWei: SIMULATED_BUY_AMOUNT_WEI, slippagePercent: 15, apiBaseUrl: "https://gmgn.test" });
        assert.equal(plan.mode, "gmgn_agent_swap");
        assert.deepEqual(plan.response, { order_id: "test-order", status: "pending" });
        assert.equal(requests.length, 1);
        assert.equal(requests[0].method, "POST");
        assert.equal(requests[0].headers.get("x-apikey"), "test-key");
        assert.ok(requests[0].headers.get("x-signature"));
        assert.match(requests[0].url, /\/v1\/trade\/swap\?/);
        const body = await requests[0].clone().json();
        assert.deepEqual(body, { chain: "robinhood", from_address: ROUTE.recipient, input_token: "0x0000000000000000000000000000000000000000", output_token: TOKEN, input_amount: SIMULATED_BUY_AMOUNT_WEI.toString(), slippage: 15, is_anti_mev: true });
    }
    finally {
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
        gasLimit: 250000n,
        maxFeePerGas: 1000000000n,
        maxPriorityFeePerGas: 100000000n,
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
    assert.equal(calculateMinimumOutput("zero", undefined, 1500n), 0n);
    assert.equal(calculateMinimumOutput("slippage", 1001n, 1500n), 850n);
});
test("simulates an immediate dry-run buy at 0.0008 ETH", () => {
    const result = simulateFastBuy(TOKEN, [{ accepted: true, expectedTokenOut: 1000n, minTokenOut: 900n }]);
    assert.equal(result.mode, "DRY_RUN");
    assert.equal(result.success, true);
    assert.equal(result.amountWei, SIMULATED_BUY_AMOUNT_WEI);
    assert.equal(result.amountWei, 800000000000000n);
    assert.equal(result.attempts[0].elapsedMs, 0);
});
test("retries quickly after a simulated first rejection", () => {
    const result = simulateFastBuy(TOKEN, [
        { accepted: false, reason: "SIMULATED_NONCE_RACE" },
        { accepted: true, expectedTokenOut: 1000n, minTokenOut: 950n },
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
