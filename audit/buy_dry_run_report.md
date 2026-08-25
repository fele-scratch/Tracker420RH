# Tracker420RH Buy Dry-Run Report

## Scope

This test exercises the simulated buy-decision path only. It does not sign, submit, or broadcast a transaction, and it does not contact a router or wallet. The configured simulated amount is exactly **0.0008 ETH**, represented as `800000000000000` wei.

## Fast-execution scenarios

| Scenario | Simulated timing | Result |
|---|---:|---|
| Immediate accepted buy | 0 ms | Passed |
| First attempt rejected, retry accepted | 0 ms, then 20 ms | Passed |
| Quote below minimum output | 0 ms | Correctly rejected |
| Live execution safeguard | N/A | Passed; no transaction hash or signed payload is produced |

The retry schedule is deterministic and configurable. The default fast schedule in the simulator is `[0, 25, 75]` milliseconds; the test used `[0, 20]` milliseconds for the explicit retry case.

## Test result

TypeScript validation and the complete Tracker420RH suite passed: **15 tests passed, 0 failed**. The dry-run buy simulator validates exact ETH sizing, immediate action timing, retry behavior, minimum-output protection, and the absence of live execution artifacts.

The simulator is intentionally isolated from the live listener’s trading adapter. The listener continues to emit launch detections with buying disabled. A production execution adapter must be reviewed separately before any real transaction capability is enabled.
