# Compliance Vault CRE Workflow

EVM-log-triggered CRE workflow for post-deposit compliance processing (step 5+ from `test.ts`).

## What It Does

- Listens for `DepositCreated` logs from Vault.
- Reads payment data on-chain from Vault using `paymentId` from the event.
- Derives CCID using the same deterministic rule as `test.ts` (`keccak256("ccid:"+lowercaseAddress)`), then validates credentials from KYC/AML/Sanctions/WorldID registries.
- Builds compliance payload and dispatches it to backend URL from config (`backend.url`) when `backend.enabled=true`.
- Computes compliance hash in the same field order as updated `test.ts`.
- In `execute` mode:
  - submits signed CRE reports to Vault `onReport` (`runtime.report` + `writeReport`)
  - anchors hash on-chain (report action `ANCHOR`)
  - settles via report action `RELEASE` only when decision is `RELEASED`
- In `dry_run` mode:
  - computes decision/hash but performs no on-chain writes.

`runMode` is configured in `config.staging.json` / `config.production.json` under `execution.runMode`.
Backend dispatch is configured under `backend.enabled` + `backend.url`.

## Simulate

From `/Users/sniperman/code/finance-os/finance-os-cre`:

```bash
cre workflow simulate ./cre \
  --target=staging-settings \
  --non-interactive \
  --trigger-index 0 \
  --evm-tx-hash 0x1111111111111111111111111111111111111111111111111111111111111111 \
  --evm-event-index 0
```

For real transaction submission during simulation, add `--broadcast`.
