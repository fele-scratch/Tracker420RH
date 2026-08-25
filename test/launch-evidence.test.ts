import assert from "node:assert/strict";
import test from "node:test";
import {
  extractAddressCandidates,
  extractPonsLaunchTokenCandidates,
  extractTraceAddresses,
  extractZeroAddressMints,
  hasLaunchEvidence,
  PONS_LAUNCH_EVENT_TOPIC,
  ERC20_TRANSFER_TOPIC,
  ZERO_TOPIC,
} from "../src/launch-analysis.js";

const TOKEN = "0x34c6ed2199274b5ff0814ca630fe4ed7f3946289";
const MOTHERSHIP = "0x6bed168687c1bca3466f1f3fb188c2dd058f4597";
const FACTORY = "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e";
const word = (address: string) => `0x${"0".repeat(24)}${address.slice(2)}`;

test("covers direct contract creation with receipt.contractAddress", () => {
  const receipt = { status: "0x1", contractAddress: TOKEN, logs: [] };
  assert.equal(hasLaunchEvidence(receipt), true);
  assert.ok(extractAddressCandidates(receipt).includes(TOKEN));
});

test("covers a generic nested mint through a zero-address Transfer event", () => {
  const receipt = {
    status: "0x1",
    contractAddress: null,
    logs: [{ address: TOKEN, topics: [ERC20_TRANSFER_TOPIC, ZERO_TOPIC, word(MOTHERSHIP)] }],
  };
  assert.deepEqual(extractZeroAddressMints(receipt), [TOKEN]);
  assert.equal(hasLaunchEvidence(receipt), true);
});

test("covers a Pons launch whose token address is emitted in event data", () => {
  const receipt = {
    status: "0x1",
    logs: [{ address: MOTHERSHIP, topics: [PONS_LAUNCH_EVENT_TOPIC, word(FACTORY)], data: word(TOKEN) + word("0x0000000000000000000000000000000000000001").slice(2) }],
  };
  assert.deepEqual(extractPonsLaunchTokenCandidates(receipt), [TOKEN]);
  assert.equal(hasLaunchEvidence(receipt, null, {
    destination: MOTHERSHIP,
    inputSelector: "0x916d099c",
    mothership: MOTHERSHIP,
    launchSelectors: new Set(["0x916d099c"]),
  }), true);
});

test("covers nested trace call targets when no mint event is emitted", () => {
  const receipt = { status: "0x1", contractAddress: null, logs: [{ address: MOTHERSHIP, topics: [], data: "0x" }] };
  const trace = [{ type: "CALL", to: FACTORY, calls: [{ type: "CREATE", result: { address: TOKEN } }] }];
  assert.deepEqual(extractTraceAddresses(trace), [FACTORY, TOKEN]);
  assert.equal(hasLaunchEvidence(receipt, trace), true);
});

test("rejects failed direct creation and failed nested launch receipts", () => {
  const receipt = { status: "0x0", contractAddress: TOKEN, logs: [] };
  assert.equal(hasLaunchEvidence(receipt), false);
});
