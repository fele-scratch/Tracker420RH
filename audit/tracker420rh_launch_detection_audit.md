# Tracker420RH Launch Detection Audit

## Test results

The Alchemy WebSocket endpoint accepted an address-filtered `alchemy_minedTransactions` subscription for Robinhood Chain using:

```json
{
  "method": "eth_subscribe",
  "params": [
    "alchemy_minedTransactions",
    {
      "addresses": [{ "from": "0x53091256ebd2d8aa37b45536a5fd864ca764f32f" }],
      "includeRemoved": false,
      "hashesOnly": false
    }
  ]
}
```

The subscription acknowledgement was received immediately. No transaction from that OKX wallet arrived during the 60-second observation window, so the test proves subscription establishment but not an observed live transaction delivery for that wallet during the test window.

The real-data end-to-end replay passed using the same wallet’s historical transactions:

| Stage | Transaction or result |
|---|---|
| Earlier mothership preparation | `0xa4a7dc22cbf61db8b67d307cca4e7797d2220c84cefee58f9b6244b1d41e5cb1`, sent to `0x6bed...f4597` with selector `0x33b8ac0e` |
| Candidate wallet | `0xce8bc5a68aa4e063c4c87094286ae9939d0d903f` |
| Candidate subscription | Alchemy `alchemy_minedTransactions` with `{ from: candidateWallet }` |
| Later launch | `0xd5fd9048cfce51df62f00802aa745c566ac85d6867cfb5c00a9e38174c9c9613`, selector `0x916d099c`, sent to `0x6bed...f4597` |
| Launch evidence | Successful Pons launch event; token-like address `0xec2009c8ce54bbbb4f0166c9bf8b03e8a3c0caf2` appears in the event data |
| Buy dependency | None; `LAUNCH_DETECTED` was emitted before any developer-buy step |

## Historical signature findings

The saved 0x6bed transaction export contained 18 observed method IDs. The relevant historical counts were `0x33b8ac0e`: 38, `0x70237117`: 30, `0x3c05c981`: 2, and `0x916d099c`: 1. This confirms that `0x3c05c981` is not a universal launch selector and must not be the sole listener trigger.

Receipt auditing showed that the recurring `0x70237117` launch records generally contain successful receipts with approximately 20 logs and zero-address mint transfers. In those records, the first unique zero-address mint contract is the likely token contract, while other fixed contracts recur across launches and appear to be pool or launch infrastructure. The `0x916d099c` example differs: its receipt has one Pons launch event and no ERC-20 zero-address Transfer, but its event data contains the created token address.

For the tested external-launch case, the token address emitted by the Pons event has deployed bytecode, but standard `name()`, `symbol()`, and `totalSupply()` calls reverted at the latest state. Therefore, generic ERC-20 metadata probing cannot be the only validation rule. A verified Pons launch event plus non-empty token bytecode is a required trusted path.

The Alchemy Robinhood Chain endpoint returned HTTP 400 for both `trace_transaction` and `debug_traceTransaction` on the historical SUSCAT launch. The listener therefore treats traces as optional: if a provider exposes them, nested `CALL` and `CREATE` targets are inspected; when the configured provider does not expose traces, receipt logs and known Pons event decoding remain the available evidence.

## Current detector coverage

| Launch path | Covered now | Evidence used |
|---|---:|---|
| Direct contract creation with `receipt.contractAddress` | Yes | Successful receipt and created address |
| ERC-20 mint visible as `Transfer(0x0, recipient, amount)` | Yes | Zero-address Transfer log and deployed bytecode |
| Pons `0x70237117` launch with zero-address mint logs | Yes | Successful receipt, mint logs, bytecode |
| Pons `0x916d099c` launch with token address in verified event data | Yes | Known Pons event topic, first data word, bytecode |
| Pons `0x3c05c981` launch with receipt-level mint | Yes | Receipt mint evidence; selector is only contextual |
| Nested mint with a token Transfer event | Yes | Receipt logs, irrespective of outer destination |
| Nested creation with provider trace output | Yes when trace RPC is available | Recursive trace `CREATE`/`CALL` addresses plus receipt evidence |
| Candidate wallet launches outside 0x6bed with generic token mint logs | Yes | Candidate-wallet subscription and zero-address mint receipt |
| Candidate wallet calls an unknown factory and emits no standard mint/event evidence | No | Requires a verified factory event ABI or trace support |
| Token address exists only in opaque calldata with no receipt/event/trace evidence | No | Requires ABI-specific calldata decoding |
| Pending transaction before mining | Not yet | Requires a provider-supported pending filtered subscription and safe retry logic |

## Operational conclusion

The primary rule is now:

> Detect a successful 0x6bed preparation event, register its outer sender, dynamically subscribe to that sender’s mined transactions, inspect the first subsequent successful candidate transaction, and emit `LAUNCH_DETECTED` as soon as a verified mint, contract creation, trusted Pons launch event, or supported nested trace identifies a token contract.

No developer buy is required. The detector does not wait for `0x59a87bc1`, and it does not require the token creator to buy. Block reconciliation remains optional and is disabled by default.

## References

[1]: https://github.com/trumpmainac/solana-cex-tracker-listener-production-ready/blob/master/src/services/transactionMonitorListener.ts "Referenced Solana wallet-specific onLogs listener"
[2]: https://www.alchemy.com/docs/how-to-subscribe-to-pending-transactions-via-websocket-endpoints "Alchemy enhanced mined transaction subscriptions"
[3]: https://www.alchemy.com/docs/reference/alchemy-pendingtransactions "Alchemy filtered pending transaction subscriptions and limits"
[4]: https://docs.robinhood.com/chain/connecting/ "Robinhood Chain connection documentation"
