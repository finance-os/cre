# Compliance Vault CRE Spec (Step 5-8 Only)

## 1. Objective

Implement the updated flow in [`test.ts`](finance-os-cre/test.ts) as a Chainlink CRE workflow under `finance-os-cre/cre`, scoped to **step 5 onward** only.

CRE starts **after** deposit is created and includes:

- Step 5: Compliance check workflow
- Step 6: Compliance result handoff (backend payload compatibility)
- Step 7: On-chain compliance hash anchoring
- Step 8: Settlement action (`release` on approve)

## 2. System Boundary

### Outside CRE (already done before trigger)

1. Generate recipient wallets
2. Create CCID identities
3. Issue credentials (KYC, AML, SANCTIONS, WORLD_ID)
4. Deposit to Vault (`DepositCreated` emitted)

### Inside CRE (this spec)

5. Read payment + evaluate compliance
6. Build/return backend-compatible audit payload
7. Anchor compliance hash on-chain
8. Release payment if approved, otherwise do not release

## 3. Deployed Contracts (Current)

Source: [`deployments.txt`](finance-os/deployments.txt)

- `vault`: `0x2E614177DA50A4d29c3ca98E1c45e1D7ab8bf253`
- `identityRegistry`: `0x1FE30a35fEA66c75f4c259862a2968460cbE35F6`
- `kycRegistry`: `0x3f8208211647D17a99Ec6458c15f00b6458263B8`
- `amlRegistry`: `0xFE701E9a8DB3Cd331d3cdF8A6bD37a40c9C2FBD8`
- `sanctionRegistry`: `0x173dea57E159EB1B4ED0bC38dfA050E452f5C64d`
- `worldidRegistry`: `0x06c1d3D73C58044FaC4A62e3429C31A80818c1CB`
- `forwarder`: `0x15fC6ae953E024d975e77382eEeC56A9101f9F88`

Other registry/factory addresses in `deployments.txt` are informational and not required in CRE execution path.

## 4. Trigger Model

## 4.1 Primary Trigger (Required)

- `evmLog` trigger on Vault `DepositCreated`.
- CRE extracts `paymentId` from event log and treats chain state as source of truth.

Event signature:

- `DepositCreated(uint256 indexed paymentId,address indexed sender,uint256 totalAmount,uint256 recipientCount,uint8 tokenType,address tokenAddress,uint8 auditMask)`

## 4.2 Simulation Inputs

For local simulation, operator provides:

- `--evm-tx-hash`
- `--evm-event-index`

No HTTP trigger/payload in this version.

## 5. Compliance Rules (Step 5)

## 5.1 Payment Read Source

- Read `Vault.getPayment(paymentId)`.
- Use on-chain fields (`sender`, `recipients[]`, `amounts[]`, `auditMask`, `tokenType`, `tokenAddress`) as authoritative input.

## 5.2 Audit Mask Bits (Updated)

- `1`: `KYC`
- `2`: `AML`
- `4`: `SANCTIONS`
- `8`: `WORLD_ID`

Note: this order differs from the old policy-engine version.

## 5.3 Identity + Credential Validation

For any address to be checked:

1. Resolve CCID via `IdentityRegistry.getIdentity(address)`.
2. If CCID is zero hash, check fails with `NO_IDENTITY`.
3. Validate by credential registry:
   - `kycRegistry.validate(ccid, keccak256("KYC"))`
   - `amlRegistry.validate(ccid, keccak256("AML"))`
   - `sanctionRegistry.validate(ccid, keccak256("SANCTIONS"))`
   - `worldidRegistry.validate(ccid, keccak256("WORLD_ID"))`

## 5.4 Sender vs Recipient Checks

- Sender checks: KYC, AML, SANCTIONS, WORLD_ID (per enabled bits)
- Recipient checks: KYC, AML, SANCTIONS (WORLD_ID not applied to recipients)

## 5.5 Decision Logic

- `RELEASED` if sender passes and all recipients pass.
- `FROZEN` otherwise.

Block reason precedence:

1. Sender failure reason (`SENDER_KYC_FAIL`, `SENDER_AML_FAIL`, `SENDER_SANCTIONS_FAIL`, `SENDER_WORLDID_FAIL`)
2. First failed recipient reason (`RECIPIENT_KYC_FAIL`, `RECIPIENT_AML_FAIL`, `RECIPIENT_SANCTIONS_FAIL`)

## 6. Backend Payload Compatibility (Step 6)

CRE must produce audit output equivalent to `CompliancePayload` in `test.ts`:

- `paymentId`
- `timestamp`
- `auditMask`
- `sender` checks + overall
- `recipients[]` checks + result
- `finalDecision` (`RELEASED | FROZEN`)
- `blockReason` (optional)

If direct backend POST is not available in runtime, CRE returns this payload in response for external relay.

## 7. Compliance Hash + Anchor (Step 7)

## 7.1 Canonical Hash Inputs (Updated Order)

Hash follows updated `test.ts` composition:

- `paymentId`
- `sender`
- `senderKyc`
- `senderAml`
- `senderSanctions`
- `recipientsHash`
- `auditMask`
- `finalDecisionBool`
- `timestamp`

`recipientsHash` uses ordered recipient tuples:

- `recipient`
- `kycPassed`
- `amlPassed`
- `sanctionsPassed`
- `amount` (`uint256` wei)

Final anchor call:

- `vault.anchorComplianceResult(paymentId, resultHash, finalDecisionCode)`
- `finalDecisionCode`: `1` for released, `2` for frozen.

## 8. Settlement (Step 8)

- If decision is `RELEASED`: call `vault.release(paymentId)`.
- If decision is `FROZEN`: do not release (funds remain locked).

For parity with updated `test.ts`, no explicit freeze transaction is required in failed path unless contract behavior later requires one.

## 9. Workflow Response Contract

Response should include:

- `strategyId`, `workflowVersion`, `trigger`, `runMode`
- `paymentId`
- `decision`
- `reason`
- `complianceHash` (when computed)
- `auditResult` payload (backend-compatible)
- `verification`:
  - `onChainMatch`
  - `mismatches[]`
  - `anchorVerified` (if applicable)
- `txRefs`:
  - `sourceDepositTx`
  - `anchorTx`
  - `settlementTx` (release tx only when released)

## 10. Config Requirements (`finance-os-cre/cre/config.*.json`)

Required contract config keys:

- `contracts.vault`
- `contracts.identityRegistry`
- `contracts.kycRegistry`
- `contracts.amlRegistry`
- `contracts.sanctionRegistry`
- `contracts.worldidRegistry`

Required trigger config:

- `trigger.evmLog.enabled`
- `trigger.evmLog.chainSelectorName`
- `trigger.evmLog.isTestnet`
- `trigger.evmLog.addresses` (Vault)
- `trigger.evmLog.topics` (`DepositCreated` topic0)
- `trigger.evmLog.confidence`

Execution config:

- `execution.runMode` (`execute | dry_run`)

Optional integration config:

- Backend endpoint URL for external relay/POST.

## 11. Failure Handling

- Invalid/unsupported log -> `ABORT`.
- Event/on-chain mismatch -> `ABORT` with mismatches.
- Any check/read failure -> check marked failed (`CHECK_ERROR`) and decision derived normally.
- Anchor failure -> `ABORT` with partial tx refs.
- Release failure -> `ABORT` with anchor tx retained.
- `dry_run` -> no on-chain writes.

## 12. Acceptance Criteria

- CRE is triggered by real/simulated Vault `DepositCreated` EVM log.
- CRE reads payment data from Vault and does not depend on HTTP payload.
- Compliance checks use Identity + Credential registries (CCID-based).
- Decision and block reasons match updated step-5 logic in `test.ts`.
- Compliance hash matches updated field ordering (`kyc, aml, sanctions`).
- Anchor call succeeds in execute mode.
- `RELEASED` path performs `release(paymentId)`.
- `FROZEN` path performs no release and reports frozen decision.
