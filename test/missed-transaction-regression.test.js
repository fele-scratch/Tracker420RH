import assert from "node:assert/strict";
import test from "node:test";
import { hasLaunchEvidence } from "../src/launch-analysis.js";
test("observed OKX transaction is not a launch candidate", () => {
    const receipt = {
        status: "0x1",
        contractAddress: null,
        logs: [],
    };
    assert.equal(hasLaunchEvidence(receipt, null, {
        destination: "0x45e8b71893b64069acbd91d904a86c4c036975a8",
        inputSelector: "0x",
        mothership: "0x6bed168687c1bca3466f1f3fb188c2dd058f4597",
        launchSelectors: new Set(["0x3c05c981", "0x33b8ac0e", "0x70237117", "0x916d099c"]),
    }), false);
});
test("unknown factory call with no receipt, creation, or trace evidence remains unconfirmed", () => {
    const receipt = {
        status: "0x1",
        contractAddress: null,
        logs: [],
    };
    assert.equal(hasLaunchEvidence(receipt, null), false);
});
