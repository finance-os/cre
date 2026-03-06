# reprieve-chainlink-api-guard-v1

Profile workflow for `CHAINLINK_API_GUARD_V1`.

## Current status

- HTTP primary trigger + cron fallback both run full V1 orchestration flow.
- V1 risk engine computes decision from adapter snapshots + Chainlink API path/fallback.
- Planner enforces single-mode rescue (`TOP_UP` or `REPAY`) and builds `executeRescue` plan.
- Source-chain execution submits signed CRE reports to `ReprieveWorkflowReceiver.onReport`, which then calls `RescueExecutor.executeRescue`.
- Execution path uses `runtime.report(...)` + `evmClient.writeReport(...)` and captures tx hash + optional CCIP message id.
- EVM-log reconciliation maps settlement lifecycle:
  - `CrossChainInitiated` -> `DISPATCHED`
  - `CrossChainCompleted` -> `DELIVERED_SUCCESS`
  - `CrossChainDestinationFailed` -> `DELIVERED_FAILED`
  - `RescueCompleted` / `RescueFailed` -> same-chain terminal tracking

## HTTP payload knobs

- `user` (`0x...`) optional, defaults to `monitoring.defaultUser`
- `runMode` = `execute | monitor_only | dry_run` (HTTP default: `execute`, cron default: `monitor_only`)
- `rescueMode` is ignored by V1 planner (mode is auto-inferred from source/target position direction)
- `executionId` (`bytes32`) optional deterministic override
- `pendingExecId` (`bytes32`) optional pending cross-chain guard
- `sourceAdapter` / `targetAdapter` optional planning hints
- `forceCrossChain` boolean optional
- `targetChainSelector` optional cross-chain override
- `targetCollateralAsset` / `targetDebtAsset` optional cross-chain asset hints
- `transferAmount` optional action amount override
- `workflowReceiver` optional receiver override for `writeReport` (defaults to `contracts.workflowReceiver` then `contracts.rescueReporter`)
- `sourceFloorHfBps` optional floor HF for rescue source preservation (default: `thresholds.earlyWarningHfBps`)
- `maxFeeWei` optional max native fee override
- `deadlineSeconds` optional deadline horizon override

## Local checks

- `bun run build`
- `bun test lib/risk-v1.test.ts`
- `cre workflow simulate ./reprieve-chainlink-api-guard-v1 --target=staging-settings`

## Multi-chain capability note

- This workflow can read adapters across multiple EVM chains in one execution.
- Base Sepolia adapters here use `chainSelectorName: ethereum-testnet-sepolia-base-1`.
- If simulation logs show `no compatible capability found for id evm:ChainSelector:10344971235874465080@1.0.0`, your current CRE target does not have Base Sepolia EVM read capability enabled. In that case, Ethereum reads succeed but Base reads fail.

## Simulate with real tx broadcast

- `simulate` defaults to dry execution for writes unless `--broadcast` is provided.
- For real `writeReport(onReport)` submission and non-zero tx hash:

```bash
cre workflow simulate ./reprieve-chainlink-api-guard-v1 \
  --target=staging-settings \
  --non-interactive \
  --trigger-index 0 \
  --broadcast \
  --http-payload '{"runMode":"execute","user":"0x..."}'
```
