import assert from "node:assert/strict";
import test from "node:test";
import { ERC20_TRANSFER_TOPIC, ZERO_TOPIC, CREATE_BUNDLE_SELECTOR, candidateWalletFromBundle, extractMintedTokens, isCandidateLaunch, selector, } from "../src/detection.js";
const MOTHERSHIP = "0x6bed168687c1bca3466f1f3fb188c2dd058f4597";
const CANDIDATE = "0xCe8bc5A68aa4E063C4c87094286AE9939d0D903f";
const TOKEN = "0x34c6ed2199274b5ff0814ca630fe4ed7f3946289";
const TX_HASH = "0x" + "ab".repeat(32);
function createBundleInput(bundleId, mode, deadline) {
    return CREATE_BUNDLE_SELECTOR + bundleId.replace(/^0x/, "").padStart(64, "0") + mode.toString(16).padStart(64, "0") + deadline.toString(16).padStart(64, "0");
}
function mintReceipt(status = "0x1") {
    return {
        status,
        logs: [
            {
                address: TOKEN,
                topics: [ERC20_TRANSFER_TOPIC, ZERO_TOPIC, "0x" + "12".repeat(32)],
            },
        ],
    };
}
test("simulates createBundle -> dynamic candidate wallet discovery without an event topic", () => {
    for (const [bundleId, mode, deadline] of [["11".repeat(32), 1, 1800000000n], ["22".repeat(32), 2, 1900000000n]]) {
        const wallet = candidateWalletFromBundle({ from: CANDIDATE, to: MOTHERSHIP, input: createBundleInput(bundleId, mode, deadline) }, MOTHERSHIP, { status: "0x1", logs: [] });
        assert.equal(wallet, CANDIDATE.toLowerCase());
    }
});
test("rejects another contract, another method, and failed createBundle", () => {
    assert.equal(candidateWalletFromBundle({ from: CANDIDATE, to: "0x" + "11".repeat(20), input: "0x33b8ac0e" }, MOTHERSHIP, { status: "0x1", logs: [] }), null);
    assert.equal(candidateWalletFromBundle({ from: CANDIDATE, to: MOTHERSHIP, input: "0x70237117" }, MOTHERSHIP, { status: "0x1", logs: [] }), null);
    assert.equal(candidateWalletFromBundle({ from: CANDIDATE, to: MOTHERSHIP, input: "0x33b8ac0e" }, MOTHERSHIP, { status: "0x0", logs: [] }), null);
});
test("simulates candidate wallet launch transaction -> ERC-20 mint extraction", () => {
    const receipt = mintReceipt();
    const minted = extractMintedTokens(receipt);
    assert.deepEqual(minted, [TOKEN]);
    assert.equal(selector("0x3c05c981deadbeef"), "0x3c05c981");
    assert.equal(isCandidateLaunch({ to: "0x" + "99".repeat(20), input: "0x3c05c981deadbeef" }, receipt, MOTHERSHIP), true);
});
test("does not treat a failed candidate transaction as a launch", () => {
    const receipt = mintReceipt("0x0");
    assert.equal(extractMintedTokens(receipt).length, 1);
    assert.equal(isCandidateLaunch({ to: MOTHERSHIP, input: "0x70237117deadbeef" }, receipt, MOTHERSHIP), false);
});
test("recognizes a known mothership launch selector but requires a mint before the buy path", () => {
    const noMint = { status: "0x1", logs: [] };
    assert.equal(isCandidateLaunch({ to: MOTHERSHIP, input: "0x70237117deadbeef" }, noMint, MOTHERSHIP), true);
    assert.equal(extractMintedTokens(noMint).length, 0);
});
