# Tracker420RH Revised Launch Coverage Report

## 1. Why transaction `0x12e41472…3716a` was not reported clearly

The transaction was real and successful. Its on-chain fields are:

| Field | Value |
|---|---|
| Sender | `0x53091256ebd2d8aa37b45536a5fd864ca764f32f` |
| Destination | `0x45e8b71893b64069acbd91d904a86c4c036975a8` |
| Input | `0x` |
| Block | `0x2b2b218` |
| Transaction index | `0x5` |
| Receipt status | Successful |
| Receipt logs | Empty |
| Block time | 2026-08-24 23:34:40 UTC |

This transaction is not a token launch according to the current evidence rules: it has no contract creation result, no receipt logs, no zero-address mint, no Pons launch event, and no known launch selector. It is therefore correctly rejected by the launch detector.

The first 60-second probe did not preserve enough output to prove whether this exact hash was delivered. Its output showed a generic `eth_subscription` message, but the old probe printed only the message type and discarded the nested transaction payload. The corrected probe now prints the hash, sender, destination, input, block, and transaction index. A subsequent three-minute run subscribed successfully but received no matching wallet notification before timeout. Therefore, the exact reason this hash was not visibly reported cannot be proven from the first probe’s lossy output. Possible explanations include the notification arriving during the old probe but being hidden by its output bug, the transaction being mined before subscription activation, or provider delivery behavior on the Robinhood Chain enhanced stream.

Alchemy documents `alchemy_minedTransactions` as a filtered mined-transaction subscription by `from` and/or `to` address [1]. Alchemy’s separate tutorial explicitly names Ethereum, Polygon, Arbitrum, and Optimism for the enhanced WebSocket workflow [2], while its Robinhood announcement confirms ordinary RPC and WebSocket support but does not explicitly guarantee that every enhanced subscription is supported on Robinhood Chain [3]. The successful subscription acknowledgement alone is therefore not sufficient proof of end-to-end delivery.

## 2. Three-minute test

The corrected three-minute test for the OKX wallet received the subscription acknowledgement and then timed out without a transaction notification. It did not submit or sign anything. The result proves that the WebSocket handshake and request were accepted, but it does not prove that the enhanced address filter reliably delivers every Robinhood Chain transaction.

## 3. Historical launch evidence

The saved 0x6bed transaction export contained the following relevant selector counts:

| Selector | Historical count | Demonstrated interpretation |
|---|---:|---|
| `0x33b8ac0e` | 38 | Preparation/configuration-style calls; many receipts had little or no launch evidence |
| `0x70237117` | 30 | Repeated Pons launch path; successful receipts commonly contained zero-address mint logs |
| `0x3c05c981` | 2 | Launch path in some historical records, not universal |
| `0x916d099c` | 1 | Pons launch path whose token address appeared in a launch event payload |

The `0x70237117` examples demonstrate that a token launch can be identified from a successful receipt and zero-address mint events. The `0x916d099c` example demonstrates a different valid path: the receipt had a Pons event with a token address in its data, but no zero-address ERC-20 Transfer. The token address was `0xec2009c8ce54bbbb4f0166c9bf8b03e8a3c0caf2`.

The Alchemy endpoint rejected both `trace_transaction` and `debug_traceTransaction` with HTTP 400 for the tested historical launch. Trace support is therefore not demonstrated on this provider. Receipt logs, transaction input, and contract bytecode remain available.

## 4. Revised coverage table

| Launch path | Status | Exact evidence used | What causes a miss | Additional ABI/event/selector work required |
|---|---|---|---|---|
| Candidate wallet directly creates a contract | Covered in tests; not demonstrated in the supplied 0x6bed history | Successful receipt with non-null `contractAddress` | Provider omits creation result or transaction is only observed after data is pruned | No for ordinary EVM creation; add provider-specific handling if needed |
| Candidate wallet directly calls a token factory and receipt emits `Transfer(0x0, …)` | Demonstrated and covered | ERC-20 Transfer topic, zero `from`, emitting contract address, deployed bytecode | Mint is nonstandard or emits no Transfer | ABI not required for the standard event |
| `0x70237117` Pons launch | Demonstrated historically and covered | Successful receipt, repeated launch selector, zero-address mint logs | Provider misses mined notification; mint event is suppressed or uses a variant event | Additional Pons ABI useful for exact token/pool discrimination |
| `0x3c05c981` launch | Demonstrated historically, conditionally covered | Selector plus receipt-level mint evidence where present | Selector appears without mint evidence; token address only in opaque calldata | Decode the method/event ABI for variants; selector alone must not trigger |
| `0x916d099c` Pons launch | Demonstrated historically and covered | Verified Pons launch event topic and token address in first data word; deployed bytecode | Event topic or data layout changes; token address is emitted elsewhere | Decode every Pons event variant and maintain versioned layouts |
| Candidate wallet calls 0x6bed and nested mint emits standard receipt logs | Demonstrated in the SUSCAT/Pons family and covered | Outer sender, successful receipt, nested-emitted mint/event logs | Logs are absent or nonstandard | Factory/pool event ABI may improve precision |
| Candidate wallet calls another factory and nested `CREATE` occurs; trace available | Theoretically covered; not demonstrated on Robinhood/Alchemy | Recursive trace `CREATE`/`CALL` targets plus receipt evidence | Provider does not expose traces or trace is rate-limited | Trace-capable RPC required; exact factory ABI optional |
| Candidate wallet calls unknown factory with no receipt event, no creation result, and no trace | Not covered and not proven to occur in the audited 0x6bed samples | No reliable on-chain fingerprint available to current RPC view | Exactly the stated absence of evidence | Requires factory-specific ABI, trace-capable RPC, or another indexed execution feed |
| Token address exists only in opaque calldata | Not covered and not proven to occur in the audited samples | Current decoder does not infer a token from arbitrary calldata | ABI layout unknown and no confirming event/trace | Required: selector-specific ABI/calldata decoders or verified factory registry |
| Ordinary wallet transaction with empty input/logs | Correctly rejected | Successful receipt alone is insufficient | None; this is an intentional false-positive safeguard | No |

## 5. Detector conclusion

The detector should not treat the developer’s buy as launch evidence. The earliest safe signal remains:

> candidate wallet detected → candidate wallet transaction delivered → successful receipt obtained → token identified from contract creation, zero-address mint, verified Pons launch event, or supported trace → `LAUNCH_DETECTED`.

The primary wallet listener remains the address-filtered mined-transaction WebSocket. However, the three-minute test shows that a successful subscription acknowledgement is not enough to certify reliable Robinhood Chain delivery. The production listener should keep the WebSocket as primary, add a second low-latency provider or native wallet-activity feed if available, and retain reconciliation strictly as recovery rather than as the primary trigger.

## References

[1]: https://www.alchemy.com/docs/reference/alchemy-minedtransactions "Alchemy — alchemy_minedTransactions reference"
[2]: https://www.alchemy.com/docs/how-to-subscribe-to-pending-transactions-via-websocket-endpoints "Alchemy — WebSocket mined transaction tutorial"
[3]: https://www.alchemy.com/blog/robinhood-chain-mainnet-is-live-on-alchemy "Alchemy — Robinhood Chain mainnet support announcement"
[4]: https://docs.robinhood.com/chain/connecting/ "Robinhood Chain — Connecting documentation"
