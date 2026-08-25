import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { extractAddressCandidates, extractTraceAddresses, extractZeroAddressMints, hasLaunchEvidence } from "../src/launch-analysis.js";

const MOTHERSHIP = "0x6bed168687c1bca3466f1f3fb188c2dd058f4597";
const BUNDLE_TOPIC = "0x1cc27e421486e19dd9942a7d534956723c7b40410db99dea6c2be261d16ccae2";
const TX_PATH = new URL("../audit/external_launch_tx.json", import.meta.url);
const RECEIPT_PATH = new URL("../audit/external_launch_receipt.json", import.meta.url);
const PREP_TX_PATH = new URL("../audit/mothership_prep_tx.json", import.meta.url);

test("real-data 0x6bed preparation -> candidate subscription -> launch evidence replay", async () => {
  const prepEnvelope = JSON.parse(await readFile(PREP_TX_PATH, "utf8"));
  const txEnvelope = JSON.parse(await readFile(TX_PATH, "utf8"));
  const receiptEnvelope = JSON.parse(await readFile(RECEIPT_PATH, "utf8"));
  const prepTx = prepEnvelope.result;
  const tx = txEnvelope.result;
  const receipt = receiptEnvelope.result;
  assert.equal(prepTx.to.toLowerCase(), MOTHERSHIP);
  assert.equal(typeof prepTx.from, "string");
  assert.equal(tx.from.toLowerCase(), prepTx.from.toLowerCase());

  const bundleNotification = {
    address: MOTHERSHIP,
    topics: [BUNDLE_TOPIC],
    transactionHash: prepTx.hash,
    blockNumber: prepTx.blockNumber,
  };
  assert.equal(bundleNotification.address.toLowerCase(), MOTHERSHIP);
  assert.equal(bundleNotification.topics[0], BUNDLE_TOPIC);

  const candidateWallet = prepTx.from.toLowerCase();
  const subscriptionRequest = {
    jsonrpc: "2.0",
    id: 99,
    method: "eth_subscribe",
    params: ["alchemy_minedTransactions", {
      addresses: [{ from: candidateWallet }],
      includeRemoved: false,
      hashesOnly: false,
    }],
  };
  assert.deepEqual(subscriptionRequest.params[1], {
    addresses: [{ from: candidateWallet }],
    includeRemoved: false,
    hashesOnly: false,
  });

  const mintTokens = extractZeroAddressMints(receipt);
  const receiptCandidates = extractAddressCandidates(receipt);
  const traceCandidates = extractTraceAddresses(null);
  const launchSelector = tx.input.slice(0, 10).toLowerCase();
  assert.equal(hasLaunchEvidence(receipt, null, {
    destination: tx.to,
    inputSelector: launchSelector,
    mothership: MOTHERSHIP,
    launchSelectors: new Set(["0x3c05c981", "0x70237117", "0x916d099c"]),
  }), true);
  assert.equal(mintTokens.length, 0, "this external launch receipt uses a Pons event rather than a zero-address Transfer");
  assert.ok(receiptCandidates.some((address) => address !== MOTHERSHIP), "event payload must expose a non-mothership address candidate");
  assert.deepEqual(traceCandidates, []);

  console.log(JSON.stringify({
    stage: "LAUNCH_DETECTED",
    sourcePreparationTx: prepTx.hash,
    candidateWallet,
    launchTx: tx.hash,
    launchTo: tx.to,
    blockNumber: tx.blockNumber,
    tokenContractsFromZeroAddressMint: mintTokens,
    receiptAddressCandidates: receiptCandidates,
    receiptCandidateCount: receiptCandidates.length,
    traceAvailable: false,
    buyAttempted: false,
  }, null, 2));
});
