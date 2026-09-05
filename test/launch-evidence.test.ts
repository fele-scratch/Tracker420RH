import assert from "node:assert/strict";
import test from "node:test";
import { isCreateBundleTransaction, isSuccessfulReceipt } from "../src/detection.js";
import { firstMeaningfulInboundFrom, firstNonBlockedToken, isActiveCandidate, isFirstFundedByOkx, isFundAmountInRange } from "../src/candidate-analysis.js";
import {
  extractAddressCandidates,
  decodeLaunchAndBuyArgs,
  extractPonsInitialPoolCandidates,
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

test("extracts the initial Pons pool from the token mint recipient", () => {
  const pool = "0x4b07b154848c8d6473df57f0582c808923e1e020";
  const receipt = {
    status: "0x1",
    logs: [{
      address: TOKEN,
      topics: [ERC20_TRANSFER_TOPIC, ZERO_TOPIC, word(pool)],
      data: "0x01",
    }],
  };
  assert.deepEqual(extractPonsInitialPoolCandidates(receipt, [TOKEN]), [pool]);
});

test("covers nested trace call targets when no mint event is emitted", () => {
  const receipt = { status: "0x1", contractAddress: null, logs: [{ address: MOTHERSHIP, topics: [], data: "0x" }] };
  const trace = [{ type: "CALL", to: FACTORY, calls: [{ type: "CREATE", result: { address: TOKEN } }] }];
  assert.deepEqual(extractTraceAddresses(trace), [FACTORY, TOKEN]);
  assert.equal(hasLaunchEvidence(receipt, trace), true);
});

test("detects a live-style Pons launch from an already-known candidate wallet", () => {
  const MOTHERSHIP = "0x6bed168687c1bca3466f1f3fb188c2dd058f4597";
  const CANDIDATE = "0x10Ea2205a84274C574118a5614c2127A42e48B84";
  const tokenAddress = "0xcf4b1cf16eacd79315c2c12bb39f5f2d6a439048";
  const bundleWallet = "0xf7dfb953afd080b53dfef07fc9abc53f8c82e435";
  const prepTx = {
    hash: "0xprep_candidate_wallet",
    from: CANDIDATE,
    to: MOTHERSHIP,
    input: "0x33b8ac0e00000000000000000000000000000000000000000000000000000000",
  };
  const launchTx = {
    hash: "0xlaunch_candidate_wallet",
    from: CANDIDATE,
    to: MOTHERSHIP,
    input: "0x916d099c00000000000000000000000000000000000000000000000000000000",
    blockNumber: "0x2a1",
    transactionIndex: "0x00",
  };
  const receipt = {
    status: "0x1",
    logs: [
      {
        address: MOTHERSHIP,
        topics: [PONS_LAUNCH_EVENT_TOPIC],
        data: `0x${tokenAddress.slice(2).padStart(64, "0")}`,
      },
      {
        address: tokenAddress,
        topics: [ERC20_TRANSFER_TOPIC, ZERO_TOPIC, word(bundleWallet)],
        data: "0x01",
      },
    ],
  };

  assert.equal(isCreateBundleTransaction(prepTx, MOTHERSHIP), true);
  assert.equal(isSuccessfulReceipt(receipt), true);
  assert.equal(launchTx.from.toLowerCase(), CANDIDATE.toLowerCase());

  const zeroMintTokens = extractZeroAddressMints(receipt);
  const ponsTokenCandidates = extractPonsLaunchTokenCandidates(receipt);
  const receiptCandidates = extractAddressCandidates(receipt);

  assert.ok(zeroMintTokens.includes(tokenAddress.toLowerCase()));
  assert.ok(ponsTokenCandidates.includes(tokenAddress.toLowerCase()));
  assert.ok(receiptCandidates.includes(tokenAddress.toLowerCase()));
  assert.equal(hasLaunchEvidence(receipt, null, {
    destination: launchTx.to,
    inputSelector: "0x916d099c",
    mothership: MOTHERSHIP,
    launchSelectors: new Set(["0x3c05c981", "0x70237117", "0x916d099c"]),
  }), true);

  console.log(JSON.stringify({
    stage: "LIVE_EVENT",
    candidateWallet: CANDIDATE,
    sourcePreparationTx: prepTx.hash,
    launchTx: launchTx.hash,
    launchTo: launchTx.to,
    launchSelector: launchTx.input.slice(0, 10),
    detectedToken: tokenAddress.toLowerCase(),
    bundleWalletRecipient: bundleWallet,
    zeroMintTokens: zeroMintTokens,
    ponsLaunchTokenCandidates: ponsTokenCandidates,
    receiptAddressCandidates: receiptCandidates,
    traceAvailable: false,
    buyAttempted: false,
  }, null, 2));
});

test("rejects failed direct creation and failed nested launch receipts", () => {
  const receipt = { status: "0x0", contractAddress: TOKEN, logs: [] };
  assert.equal(hasLaunchEvidence(receipt), false);
});

function launchAndBuyInput(exemptionCount: number): string {
  const recipient = "0x" + "10".repeat(20);
  const correctedHead = [224n, 1n, BigInt("0x" + "22".repeat(20)), 2n, 3n, BigInt(recipient), 7n * 32n]
    .map((value) => value.toString(16).padStart(64, "0")).join("");
  const values = Array.from({ length: exemptionCount }, (_, index) => ("0x" + (index + 1).toString(16).padStart(40, "0")).slice(2).padStart(64, "0")).join("");
  return "0xf85f8e41" + correctedHead + exemptionCount.toString(16).padStart(64, "0") + values;
}

test("decodes launchAndBuy recipient and bounded exemption list", () => {
  const decoded = decodeLaunchAndBuyArgs(launchAndBuyInput(25));
  assert.equal(decoded?.recipient, "0x1010101010101010101010101010101010101010");
  assert.equal(decoded?.exemptions.length, 25);
  assert.equal(decodeLaunchAndBuyArgs(launchAndBuyInput(24), 25, 32), null);
  assert.equal(decodeLaunchAndBuyArgs(launchAndBuyInput(33), 25, 32), null);
});

test("accepts fund amounts only within inclusive bounds", () => {
  assert.equal(isFundAmountInRange(560000000000000000n, 0.56, 3.6), true);
  assert.equal(isFundAmountInRange(3600000000000000000n, 0.56, 3.6), true);
  assert.equal(isFundAmountInRange(559999999999999999n, 0.56, 3.6), false);
  assert.equal(isFundAmountInRange(3600000000000000001n, 0.56, 3.6), false);
});

test("accepts the funder only when it is the first meaningful inbound", () => {
  const recipient = "0x1010101010101010101010101010101010101010";
  const funder = "0x53091256EBD2D8aA37B45536A5FD864ca764f32f";
  const other = "0x2020202020202020202020202020202020202020";
  assert.equal(firstMeaningfulInboundFrom([
    { from: "0x0000000000000000000000000000000000000000", to: recipient, value: 1 },
    { from: funder, to: recipient, value: 0.56, asset: "ETH" },
  ], recipient), funder.toLowerCase());
  assert.equal(firstMeaningfulInboundFrom([
    { from: other, to: recipient, value: 0.1, asset: "ETH" },
    { from: funder, to: recipient, value: 0.56, asset: "ETH" },
  ], recipient), other.toLowerCase());
});

test("requires the triggering OKX transfer to be the first inbound transaction", () => {
  const recipient = "0x1010101010101010101010101010101010101010";
  const funder = "0x53091256EBD2D8aA37B45536A5FD864ca764f32f";
  const fundingTxHash = "0xfunding";
  assert.equal(isFirstFundedByOkx(
    [{ from: funder, to: recipient, value: 0.56, asset: "ETH", hash: fundingTxHash }],
    recipient, funder, fundingTxHash,
  ), true);
  assert.equal(isFirstFundedByOkx(
    [{ from: "0x2020202020202020202020202020202020202020", to: recipient, value: 0.1, asset: "ETH", hash: "0xprior" },
      { from: funder, to: recipient, value: 0.56, asset: "ETH", hash: fundingTxHash }],
    recipient, funder, fundingTxHash,
  ), false);
  assert.equal(isFirstFundedByOkx(
    [{ from: funder, to: recipient, value: 0.56, asset: "ETH", hash: fundingTxHash }],
    recipient, funder, "0xother",
  ), false);
});

test("decodes launchAndBuy regardless of exemption count", () => {
  assert.equal(decodeLaunchAndBuyArgs(launchAndBuyInput(1))?.recipient, "0x1010101010101010101010101010101010101010");
});

test("matches only active candidate inventory entries", () => {
  const wallet = "0x1010101010101010101010101010101010101010";
  const inventory = new Map([[wallet, { expiresAt: 200 }]]);
  assert.equal(isActiveCandidate(inventory, wallet.toUpperCase(), 100), true);
  assert.equal(isActiveCandidate(inventory, wallet, 200), false);
  assert.equal(isActiveCandidate(inventory, "0x2020202020202020202020202020202020202020", 100), false);
});

test("reported swap and modifyLiquidities hashes fail the strict launch gate", () => {
  const router = "0xe33e9e479df8802cb0866d5d05258bec4cf62948";
  const reported = [
    ["0xac82217f33ade324226cbdce51156490bbd0d24816893f8ee1b65cb73f438062", "0xdd46508f"],
    ["0x00010c0ca5c1f361799f88c89ecae0c34d07bbe423203979ca8fc1b018818605", "0x4d819a2a"],
    ["0x39d2e6736ecd329af466d687f2315b8ed9a30e3da8e6317df6c01f124f07fa16", "0x4d819a2a"],
  ];
  for (const [hash, method] of reported) {
    const tx = { hash, to: router, input: method };
    const passesLaunchGate = tx.to?.toLowerCase() === router && tx.input.slice(0, 10).toLowerCase() === "0xf85f8e41";
    assert.equal(passesLaunchGate, false, hash);
  }
});

test("skips WETH and zero address when selecting a zero mint token", () => {
  const blocklist = new Set([
    "0x0000000000000000000000000000000000000000",
    "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
  ]);
  assert.equal(firstNonBlockedToken([
    "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
    "0x1111111111111111111111111111111111111111",
  ], blocklist), "0x1111111111111111111111111111111111111111");
});
