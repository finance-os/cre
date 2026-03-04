# 🏗️ Architecture — Compliance Payment Vault (v2)

## Fully ACE + On-Chain KYC Credential + Per-Recipient Compliance + Dual-Layer Audit

**System design · Deposit (Batch) → Per-Recipient Compliance Check → Aggregate Decision → Release → Dual-Layer Audit (Off-Chain Detail + On-Chain Hash)**

Scope: Single-chain Vault → CRE orchestration → ACE on-chain policies → per-recipient compliance → off-chain detail emit → on-chain hash anchor

---

# 1️⃣ High-Level Architecture

## Core Principles

- Batch payment support (1 sender → many recipients)
- **Per-recipient compliance validation** (each recipient checked individually)
- **Transparent compliance visibility** (users can verify each check result)
- Selective compliance audit (configurable per payment via `auditMask`)
- **Dual-layer audit**: Detailed off-chain events + Immutable on-chain hash
- Raw compliance breakdown sent to backend/indexer for user visibility

---

# 2️⃣ Smart Contract Layer

## 2.1 Vault.sol

### Payment Structure (Batch Design)

```solidity
struct Payment {
    address sender;
    address[] recipients;
    uint256[] amounts;
    uint8 status; // 0=PENDING, 1=APPROVED, 2=BLOCKED, 3=RELEASED
    uint8 auditMask; 
    // bitmask: 1=KYC, 2=Sanctions, 4=AML, 8=WorldID
    uint256 createdAt;
}

// Per-recipient compliance results (stored temporarily during evaluation)
struct RecipientCompliance {
    address recipient;
    bool kycPassed;      // null if not checked (auditMask & 1 == 0)
    bool sanctionsPassed; // null if not checked (auditMask & 2 == 0)
    bool amlPassed;      // null if not checked (auditMask & 4 == 0)
    bool worldIdPassed;  // null if not checked (auditMask & 8 == 0)
    uint256 amount;
}
```

### Deposit Function (Batch)

```solidity
function deposit(
    address[] calldata recipients,
    uint256[] calldata amounts,
    uint8 auditMask
) external payable;
```

### Requirements

- `recipients.length == amounts.length`
- `Sum(amounts) == msg.value`
- `auditMask` must not be 0
- Create Payment struct
- Emit `DepositCreated`

### Deposit Event

```solidity
event DepositCreated(
    uint256 indexed paymentId,
    address indexed sender,
    uint256 totalAmount,
    uint256 recipientCount,
    uint8 auditMask
);
```

> ⚠️ Individual recipients and amounts are NOT emitted to save gas. Backend reads them from calldata.

### Settlement Functions

- `release(paymentId)` — callable only by CRE, transfers funds to recipients
- `freeze(paymentId)` — callable only by CRE, locks funds (status = FROZEN)
- `refund(paymentId)` — callable only by CRE, returns funds to sender (for FROZEN payments)

---

## 2.2 ACE Policy Contracts (On-Chain)

### KYCCredentialPolicy.sol

```solidity
function validate(address wallet) external view returns (bool);
```

### SanctionsPolicy.sol

```solidity
function validate(address wallet) external view returns (bool);
```

### AMLPolicy.sol

```solidity
function validate(address sender, uint256 totalAmount) external view returns (bool);
function validateRecipient(address recipient, uint256 amount) external view returns (bool);
```

---

# 3️⃣ Selective Audit Design

Each Payment has `auditMask`.

## auditMask Bit Layout

| Bit | Value | Check Type       | Applies To        |
|-----|-------|------------------|-------------------|
| 0   | 1     | KYC              | Sender + All Recipients |
| 1   | 2     | Sanctions        | Sender + All Recipients |
| 2   | 4     | AML              | Sender (volume) + Per-recipient |
| 3   | 8     | WorldID (off-chain) | Sender only |

Example:

- `auditMask = 3` → KYC + Sanctions for everyone
- `auditMask = 5` → KYC + AML for everyone
- `auditMask = 15` → All checks

---

# 4️⃣ CRE Workflow (Per-Recipient Evaluation)

When CRE receives `DepositCreated`:

## Step-by-Step Evaluation

```
1. Parse auditMask from event
2. For SENDER:
   - Check KYC if (auditMask & 1)
   - Check Sanctions if (auditMask & 2)
   - Check AML (daily volume) if (auditMask & 4)
   - Verify WorldID if (auditMask & 8)

3. For EACH RECIPIENT:
   - Check KYC if (auditMask & 1)
   - Check Sanctions if (auditMask & 2)
   - Check AML (per-recipient limit) if (auditMask & 4)

4. Aggregate results:
   - **ANY fail → FROZEN entire payment** (blocked, not released)
   - ALL pass → RELEASED
```

## Decision Logic

```solidity
// Per-recipient validation
for each recipient in payment.recipients:
    if (auditMask & KYC_BIT) && !kycPolicy.validate(recipient):
        recipientFailed = true
        failureReason = "KYC_FAIL"
    
    if (auditMask & SANCTIONS_BIT) && !sanctionsPolicy.validate(recipient):
        recipientFailed = true
        failureReason = "SANCTIONS_FAIL"
    
    if (auditMask & AML_BIT) && !amlPolicy.validateRecipient(recipient, amount):
        recipientFailed = true
        failureReason = "AML_FAIL"

// Final decision
if senderFailed OR any recipientFailed:
    decision = FROZEN  // Payment blocked, funds locked
else:
    decision = RELEASED  // Payment approved, funds transferred
```

---

# 5️⃣ Dual-Layer Audit System

## Layer 1: Off-Chain Detailed Events (For User Visibility)

CRE emits detailed compliance events to backend BEFORE anchoring hash on-chain.

### Event Payload Structure

```json
{
  "paymentId": 42,
  "timestamp": 1710000000,
  "auditMask": 7,
  "sender": {
    "address": "0xSender...",
    "checks": {
      "kyc": { "checked": true, "passed": true },
      "sanctions": { "checked": true, "passed": true },
      "aml": { "checked": true, "passed": true, "dailyVolume": "2.5 ETH" },
      "worldId": { "checked": false, "passed": null }
    },
    "overallResult": "PASS"
  },
  "recipients": [
    {
      "address": "0xRecipient1...",
      "amount": "1.0 ETH",
      "checks": {
        "kyc": { "checked": true, "passed": true },
        "sanctions": { "checked": true, "passed": true },
        "aml": { "checked": true, "passed": true }
      },
      "result": "PASS"
    },
    {
      "address": "0xRecipient2...",
      "amount": "1.5 ETH",
      "checks": {
        "kyc": { "checked": true, "passed": false, "reason": "CREDENTIAL_EXPIRED" },
        "sanctions": { "checked": true, "passed": true },
        "aml": { "checked": true, "passed": true }
      },
      "result": "FAIL"
    }
  ],
  "finalDecision": "BLOCK",
  "blockReason": "RECIPIENT_KYC_FAIL"
}
```

### Backend Storage & User API

Backend stores full breakdown and provides API for users to query:

```http
GET /api/compliance/{paymentId}

Response:
{
  "paymentId": 42,
  "status": "BLOCKED",
  "senderCompliance": { ... },
  "recipientCompliance": [
    { "address": "0x...", "status": "PASS", "details": {...} },
    { "address": "0x...", "status": "FAIL", "reason": "KYC_EXPIRED" }
  ],
  "onChainHash": "0xabc123...",
  "verified": true
}
```

### User Visibility Dashboard

Users can see:

| Address | Role | KYC | Sanctions | AML | Result |
|---------|------|-----|-----------|-----|--------|
| 0xSender... | Sender | ✅ | ✅ | ✅ | **PASS** |
| 0xRecip1... | Recipient | ✅ | ✅ | ✅ | **PASS** |
| 0xRecip2... | Recipient | ❌ Expired | ✅ | ✅ | **FAIL** |

**Overall Payment Status**: 🧊 **FROZEN** (Recipient 2 failed KYC - can be refunded)

---

## Layer 2: On-Chain Hash Anchor (Immutable Proof)

After emitting off-chain details, CRE computes and anchors hash on-chain.

### Hash Computation

```solidity
// Hash includes per-recipient results
complianceHash = keccak256(
    abi.encode(
        paymentId,
        sender,
        senderKycResult,
        senderSanctionsResult,
        senderAmlResult,
        senderWorldIdResult,
        recipientsHash, // merkle root of recipient results
        auditMask,
        finalDecision,
        block.timestamp
    )
);

// Where recipientsHash is computed as:
recipientData = abi.encode(
    recipient.address,
    recipient.kycPassed,
    recipient.sanctionsPassed,
    recipient.amlPassed,
    recipient.amount
);
recipientsHash = keccak256(allRecipientData);
```

### On-Chain Events

```solidity
event ComplianceResultAnchored(
    uint256 indexed paymentId,
    bytes32 resultHash,
    uint8 finalDecision, // 1=PASS, 2=BLOCK
    uint256 timestamp
);
```

> ⚠️ **No per-recipient events emitted on-chain** to save gas. All recipient details go to backend off-chain only.

---

# 6️⃣ Verification Flow

## How Users Verify Compliance

### Step 1: Query Backend (Detailed View)

```javascript
const result = await fetch(`/api/compliance/${paymentId}`).then(r => r.json());

// Display to user
console.log(`Payment ${paymentId} Status: ${result.status}`);
console.log(`Sender: ${result.senderCompliance.overallResult}`);

result.recipientCompliance.forEach((r, i) => {
  console.log(`Recipient ${i+1}: ${r.address} → ${r.status}`);
  if (r.status === "FAIL") {
    console.log(`  Reason: ${r.reason}`);
  }
});
```

### Step 2: Verify On-Chain (Trustless)

```javascript
// Fetch on-chain hash
const onChainHash = await vault.complianceHashes(paymentId);

// Recompute hash from backend data
const recomputedHash = computeHash(result);

// Verify match
if (onChainHash === recomputedHash) {
  console.log("✅ Compliance data verified on-chain");
} else {
  console.log("❌ Hash mismatch - data may be tampered");
}
```

---

# 7️⃣ Full Execution Flow

```
User completes KYC (if required)
       ↓
User deposits batch to Vault with auditMask
       ↓
Vault emits DepositCreated(paymentId, sender, auditMask...)
       ↓
┌─────────────────────────────────────────────────────────────┐
│  CRE LISTENS TO EVENT                                       │
│  1. Read auditMask                                          │
│  2. For SENDER:                                             │
│     - Check KYC (if selected)                               │
│     - Check Sanctions (if selected)                         │
│     - Check AML volume (if selected)                        │
│     - Verify WorldID (if selected, off-chain)               │
│  3. For EACH RECIPIENT:                                     │
│     - Check KYC (if selected)                               │
│     - Check Sanctions (if selected)                         │
│     - Check AML (if selected)                               │
│  4. Aggregate results                                       │
└─────────────────────────────────────────────────────────────┘
       ↓
CRE SENDS OFF-CHAIN (to backend/indexer via HTTP/API)
  ├─ Detailed compliance breakdown
  ├─ Per-recipient results
  ├─ Failure reasons (if any)
  └─ Final decision
       ↓
CRE CALLS ON-CHAIN (based on evaluation)
  ├─ IF all checks PASSED: release(paymentId)
  ├─ IF any check FAILED: freeze(paymentId)  // Funds locked, can refund later
  └─ anchorComplianceResult(paymentId, hash, decision)
       ↓
Vault emits ComplianceResultAnchored(paymentId, hash, decision, timestamp)
       ↓
USER CAN NOW:
  ├─ Query backend for detailed view
  ├─ Verify hash matches on-chain
  └─ See exactly which checks passed/failed
```

---

# 8️⃣ Compliance Failure Scenarios

## Scenario 1: Sender Fails KYC

```json
{
  "paymentId": 42,
  "finalDecision": "FROZEN",
  "freezeReason": "SENDER_KYC_FAIL",
  "sender": {
    "checks": {
      "kyc": { "checked": true, "passed": false, "reason": "NO_CREDENTIAL" }
    }
  },
  "recipients": null // Not checked due to sender failure
}
```

## Scenario 2: One Recipient Sanctioned

```json
{
  "paymentId": 43,
  "finalDecision": "FROZEN",
  "freezeReason": "RECIPIENT_SANCTIONS_FAIL",
  "sender": {
    "checks": { "kyc": true, "sanctions": true },
    "overallResult": "PASS"
  },
  "recipients": [
    { "address": "0xGood...", "result": "PASS", "checks": {...} },
    { 
      "address": "0xSanctioned...", 
      "result": "FAIL", 
      "checks": {
        "sanctions": { "checked": true, "passed": false, "reason": "OFAC_LISTED" }
      }
    }
  ]
}
```

## Scenario 3: AML Daily Limit Exceeded

```json
{
  "paymentId": 44,
  "finalDecision": "FROZEN",
  "freezeReason": "SENDER_AML_LIMIT",
  "sender": {
    "checks": {
      "kyc": { "passed": true },
      "aml": { 
        "passed": false, 
        "reason": "DAILY_LIMIT_EXCEEDED",
        "currentDailyVolume": "9.5 ETH",
        "attemptedAmount": "2.0 ETH",
        "dailyLimit": "10 ETH"
      }
    }
  }
}
```

---

# 9️⃣ Security & Trust Model

| Layer | Responsibility | Data Stored |
|-------|---------------|-------------|
| Vault | Funds custody | Payment struct, compliance hash |
| Policies | Deterministic validation | Rules, lists |
| CRE | Orchestration | Temporary evaluation data |
| Backend | Detailed compliance storage | Full breakdown, per-recipient results |
| Blockchain | Immutable hash anchor | paymentId → hash mapping |

**Trust Assumptions:**

- User trusts CRE to evaluate correctly (can be verified by re-running checks)
- User trusts backend to store correct data (can be verified against on-chain hash)
- Anyone can verify hash integrity trustlessly

---

# 10️⃣ Architecture Properties

- ✅ Batch payments supported
- ✅ Per-recipient compliance validation
- ✅ Transparent failure reasons
- ✅ Dual-layer audit (off-chain detail + on-chain proof)
- ✅ User-verifiable compliance results
- ✅ Selective compliance enforcement
- ✅ Deterministic evaluation
- ✅ Minimal gas footprint (hash only on-chain)
- ✅ Tamper-evident audit trail
- ✅ No PII on-chain

---

# ✅ Final Summary

This v2 architecture provides:

- **Per-recipient compliance checking** — each recipient validated individually
- **Transparent user visibility** — users see exactly which checks passed/failed
- **Detailed failure reasons** — know why a payment was blocked
- **Dual-layer audit system**:
  - Off-chain: Full compliance breakdown for user queries
  - On-chain: Immutable hash for trustless verification
- **Cryptographic integrity** — recompute hash to verify backend data
- **Fully modular ACE-based validation**

Users can:
1. Query backend to see detailed compliance results
2. Verify on-chain hash matches
3. Understand exactly why a payment passed or failed
4. Trustlessly audit compliance decisions
5. Request refund if payment was FROZEN (via refund function)

