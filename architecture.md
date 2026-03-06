# 🏗️ Architecture — Cross-Chain Identity Payment Vault

## Overview

A compliance-first payment escrow system with Cross-Chain Identity (CCID) verification and Chainlink CRE (Chainlink Runtime Environment) integration for automated settlement.

**System Flow:**

```
User Deposit (ETH/ERC20) → CRE Compliance Check → Settlement (Release/Freeze/Refund) → Audit
```

---

# 1️⃣ High-Level Architecture

## Core Components

1. **Vault** - Main escrow contract holding funds and managing payment lifecycle
2. **Identity Registry** - Maps blockchain addresses to Cross-Chain IDs (CCID)
3. **Credential Registry** - Manages credentials (KYC, AML, Sanctions, WorldID) attached to CCIDs
4. **Trusted Issuer Registry** - Manages trusted credential issuers
5. **Identity Validator** - Validates identities based on credential requirements
6. **ReceiverTemplate** - Enables Chainlink CRE integration for automated settlement

## Key Features

- **Multi-Token Support**: Both ETH and any ERC20 tokens
- **Batch Payments**: One sender → multiple recipients in single transaction
- **Configurable Compliance**: Selective checks via `auditMask` bitmask
- **Automated Settlement**: Chainlink CRE integration for automatic release/freeze
- **Dual-Layer Audit**: Off-chain details + on-chain hash verification
- **Cross-Chain Identity**: CCID enables identity portability across chains

---

# 2️⃣ Smart Contract Layer

## 2.1 Vault.sol

Main escrow contract inheriting from `ReceiverTemplate` for Chainlink CRE integration.

### Enums

```solidity
enum Status { PENDING, RELEASED, BLOCKED }
enum TokenType { ETH, ERC20 }
enum ActionType { RELEASE, FREEZE, REFUND, ANCHOR }
```

### Data Structures

```solidity
struct Payment {
    address sender;
    address[] recipients;
    uint256[] amounts;
    TokenType tokenType;
    address tokenAddress;    // address(0) for ETH
    uint8 status;            // 0=PENDING, 1=RELEASED, 2=BLOCKED
    uint8 auditMask;         // bitmask: 1=KYC, 2=AML, 4=SANCTIONS, 8=WORLD_ID
    uint256 createdAt;
}

struct ReportData {
    ActionType action;       // RELEASE(0), FREEZE(1), REFUND(2), ANCHOR(3)
    uint256 paymentId;
    bytes32 resultHash;      // For ANCHOR action
    uint8 finalDecision;     // 1=PASS, 2=FAIL (for ANCHOR)
}
```

### Key Functions

| Function                                              | Description                 | Access    |
| ----------------------------------------------------- | --------------------------- | --------- |
| `depositETH(recipients, amounts, auditMask)`          | Create ETH payment          | Public    |
| `depositERC20(token, recipients, amounts, auditMask)` | Create ERC20 payment        | Public    |
| `release(paymentId)`                                  | Release funds to recipients | Owner/CRE |
| `freeze(paymentId)`                                   | Freeze payment              | Owner/CRE |
| `refund(paymentId)`                                   | Refund to sender            | Owner/CRE |
| `anchorComplianceResult(paymentId, hash, decision)`   | Anchor audit hash           | Owner/CRE |
| `validateCredentials(account)`                        | Check credentials           | View      |
| `decodeAuditMask(mask)`                               | Decode bitmask              | Pure      |

### Chainlink CRE Integration

```solidity
// Called by KeystoneForwarder via onReport
function _processReport(bytes calldata report) internal override {
    ReportData memory data = abi.decode(report, (ReportData));

    if (data.action == ActionType.RELEASE) {
        _release(data.paymentId);
    } else if (data.action == ActionType.FREEZE) {
        _freeze(data.paymentId);
    } else if (data.action == ActionType.REFUND) {
        _refund(data.paymentId);
    } else if (data.action == ActionType.ANCHOR) {
        _anchorComplianceResult(data.paymentId, data.resultHash, data.finalDecision);
    }
}
```

---

## 2.2 IdentityRegistry.sol

Manages the mapping between blockchain addresses and Cross-Chain IDs (CCID).

### Data Structure

```solidity
struct IdentityRegistryStorage {
    mapping(address account => bytes32 ccid) accountToCcid;
    mapping(bytes32 ccid => address[] accounts) ccidToAccounts;
    mapping(bytes32 ccid => mapping(address account => uint256 index)) accountIndex;
    bool initialized;
}
```

### Key Functions

| Function                                  | Description                | Access |
| ----------------------------------------- | -------------------------- | ------ |
| `registerIdentity(ccid, account)`         | Register new identity      | Owner  |
| `registerIdentities(ccids[], accounts[])` | Batch registration         | Owner  |
| `removeIdentity(ccid, account)`           | Remove identity mapping    | Owner  |
| `getIdentity(account)`                    | Get CCID from address      | View   |
| `getAccounts(ccid)`                       | Get all addresses for CCID | View   |

---

## 2.3 CredentialRegistry.sol

Manages credentials attached to CCIDs with expiration support.

### Data Structures

```solidity
struct Credential {
    uint40 expiresAt;        // 0 = never expires
    bytes credentialData;
}

struct CredentialRegistryStorage {
    mapping(bytes32 ccid => bytes32[] credentialTypeIds) credentialTypeIdsByCCID;
    mapping(bytes32 ccid => mapping(bytes32 credentialTypeId => Credential credentials)) credentials;
    bool initialized;
}
```

### Key Functions

| Function                                                  | Description         | Access |
| --------------------------------------------------------- | ------------------- | ------ |
| `registerCredential(ccid, typeId, expiresAt, data)`       | Issue credential    | Owner  |
| `registerCredentials(ccid, typeIds[], expiresAt, data[])` | Batch issue         | Owner  |
| `removeCredential(ccid, typeId)`                          | Remove credential   | Owner  |
| `renewCredential(ccid, typeId, expiresAt)`                | Renew expiration    | Owner  |
| `validate(ccid, typeId)`                                  | Check if valid      | View   |
| `getCredential(ccid, typeId)`                             | Get credential data | View   |
| `isCredentialExpired(ccid, typeId)`                       | Check expiration    | View   |

---

## 2.4 TrustedIssuerRegistry.sol

Manages trusted issuers who can issue credentials.

### Data Structure

```solidity
struct TrustedIssuerRegistryStorage {
    mapping(bytes32 issuerIdHash => bool isTrusted) trustedIssuers;
    bytes32[] issuerList;
    bool initialized;
}
```

### Key Functions

| Function                        | Description        | Access |
| ------------------------------- | ------------------ | ------ |
| `addTrustedIssuer(issuerId)`    | Add trusted issuer | Owner  |
| `removeTrustedIssuer(issuerId)` | Remove issuer      | Owner  |
| `isTrustedIssuer(issuerId)`     | Check if trusted   | View   |
| `getTrustedIssuers()`           | Get all issuers    | View   |

---

## 2.5 CredentialRegistryIdentityValidator.sol

Validates identities based on credential requirements from multiple registries.

### Data Structures

```solidity
struct CredentialRequirement {
    bytes32[] credentialTypeIds;
    uint256 minValidations;
    bool invert;
}

struct CredentialSource {
    address identityRegistry;
    address credentialRegistry;
    address dataValidator;
}
```

### Key Functions

| Function                                                     | Description          | Access |
| ------------------------------------------------------------ | -------------------- | ------ |
| `initialize(sources[], requirements[])`                      | Initialize validator | Public |
| `validate(account, context)`                                 | Validate account     | View   |
| `addCredentialRequirement(input)`                            | Add requirement      | Owner  |
| `removeCredentialRequirement(id)`                            | Remove requirement   | Owner  |
| `addCredentialSource(input)`                                 | Add source           | Owner  |
| `removeCredentialSource(typeId, identityReg, credentialReg)` | Remove source        | Owner  |

---

## 2.6 ReceiverTemplate.sol

Abstract contract for Chainlink CRE integration providing secure report processing.

### Security Features

- Forwarder address validation
- Optional workflow ID validation
- Optional author (workflow owner) validation
- Optional workflow name validation
- ERC165 interface detection

### Key Functions

| Function                        | Description                        |
| ------------------------------- | ---------------------------------- |
| `onReport(metadata, report)`    | Entry point from KeystoneForwarder |
| `setForwarderAddress(address)`  | Update forwarder (Owner)           |
| `setExpectedWorkflowId(id)`     | Set workflow ID (Owner)            |
| `setExpectedAuthor(address)`    | Set author (Owner)                 |
| `setExpectedWorkflowName(name)` | Set workflow name (Owner)          |

### Forwarder Addresses (Sepolia)

| Environment       | Address                                      |
| ----------------- | -------------------------------------------- |
| Simulation (Mock) | `0x15fC6ae953E024d975e77382eEeC56A9101f9F88` |
| Production        | `0xF8344CFd5c43616a4366C34E3EEE75af79a74482` |

---

## 2.7 CredentialTypes.sol

Library defining standard credential type identifiers.

### Constants

```solidity
bytes32 constant KYC = keccak256("KYC");
bytes32 constant AML = keccak256("AML");
bytes32 constant SANCTIONS = keccak256("SANCTIONS");
bytes32 constant WORLD_ID = keccak256("WORLD_ID");
```

---

## 2.8 Factory Contracts

EIP-1167 minimal proxy pattern for gas-efficient registry deployment.

### IdentityRegistryFactory

```solidity
function createIdentityRegistry(
    address implementation,
    bytes32 uniqueRegistryId,
    address initialOwner
) external returns (address);

function predictRegistryAddress(
    address creator,
    address implementation,
    bytes32 uniqueRegistryId
) external view returns (address);
```

### CredentialRegistryFactory

```solidity
function createCredentialRegistry(
    address implementation,
    bytes32 uniqueRegistryId,
    address initialOwner
) external returns (address);
```

### TrustedIssuerRegistryFactory

```solidity
function createTrustedIssuerRegistry(
    address implementation,
    bytes32 uniqueRegistryId,
    address initialOwner
) external returns (address);
```

---

# 3️⃣ Audit Mask Design

Each payment has an `auditMask` defining which compliance checks are required.

## Bit Layout

| Bit | Value | Credential | Check Scope             |
| --- | ----- | ---------- | ----------------------- |
| 0   | 1     | KYC        | Sender + All Recipients |
| 1   | 2     | AML        | Sender + All Recipients |
| 2   | 4     | SANCTIONS  | Sender + All Recipients |
| 3   | 8     | WORLD_ID   | Sender only             |

## Examples

```solidity
uint8 auditMask = 3;   // KYC + AML
uint8 auditMask = 7;   // KYC + AML + SANCTIONS
uint8 auditMask = 15;  // All checks
```

---

# 4️⃣ CRE Workflow Integration

## Workflow Steps

1. **Listen**: CRE watches for `DepositCreated` event from Vault
2. **Evaluate**: Parse `auditMask` and check each required credential
3. **Decide**:
   - ALL checks pass → `RELEASE`
   - ANY check fails → `FREEZE`
4. **Report**: Send off-chain details to backend
5. **Settle**: Call `onReport` with action via KeystoneForwarder
6. **Anchor**: Store compliance hash on-chain

## ReportData Actions

```solidity
enum ActionType {
    RELEASE,  // Transfer funds to recipients
    FREEZE,   // Block payment
    REFUND,   // Return funds to sender
    ANCHOR    // Store compliance hash
}
```

---

# 5️⃣ Dual-Layer Audit System

## Layer 1: Off-Chain Details

Backend stores full compliance breakdown:

```json
{
  "paymentId": 42,
  "auditMask": 7,
  "sender": {
    "address": "0xSender...",
    "checks": {
      "kyc": { "checked": true, "passed": true },
      "aml": { "checked": true, "passed": true },
      "sanctions": { "checked": true, "passed": true }
    },
    "overallResult": "PASS"
  },
  "recipients": [...],
  "finalDecision": "RELEASE"
}
```

## Layer 2: On-Chain Hash

Immutable proof anchored on-chain:

```solidity
complianceHash = keccak256(abi.encode(
    paymentId,
    sender,
    senderResults,
    recipientsHash,
    auditMask,
    finalDecision,
    timestamp
));
```

Event:

```solidity
event ComplianceResultAnchored(
    uint256 indexed paymentId,
    bytes32 resultHash,
    uint8 finalDecision,
    uint256 timestamp
);
```

---

# 6️⃣ Cross-Chain Identity Flow

```
┌─────────────┐      ┌─────────────┐      ┌─────────────┐
│   Address   │─────▶│    CCID     │─────▶│ Credentials │
│  (Chain A)  │      │(Universal)  │      │ (KYC/AML)   │
└─────────────┘      └─────────────┘      └─────────────┘
       │                                           │
       └───────────────────┬───────────────────────┘
                           ▼
                  ┌────────────────┐
                  │ Identity       │
                  │ Validator      │
                  └────────────────┘
                           │
                           ▼
                    ┌─────────────┐
                    │    Vault    │
                    │  Settlement │
                    └─────────────┘
```

---

# 7️⃣ Security Model

## Access Control

| Contract              | Action                          | Access                              |
| --------------------- | ------------------------------- | ----------------------------------- |
| Vault                 | release/freeze/refund/anchor    | Owner or CRE (via ReceiverTemplate) |
| IdentityRegistry      | register/remove                 | Owner                               |
| CredentialRegistry    | register/remove/renew           | Owner                               |
| TrustedIssuerRegistry | add/remove                      | Owner                               |
| Validator             | add/remove sources/requirements | Owner                               |

## Trust Assumptions

1. **Owner**: Trusted to manage registries and settlement
2. **CRE**: Trusted to evaluate compliance correctly (verifiable via hash)
3. **Backend**: Trusted to store off-chain details (verifiable against on-chain hash)

---

# 8️⃣ Deployment Architecture

## Contract Dependencies

```
Vault
 ├── ReceiverTemplate (Chainlink CRE)
 ├── CredentialTypes
 └── IIdentityValidator

IdentityRegistry
 └── Ownable

CredentialRegistry
 └── Ownable

TrustedIssuerRegistry
 └── Ownable

CredentialRegistryIdentityValidator
 ├── Ownable
 ├── ICredentialRequirements
 └── IIdentityValidator

Factories
 └── Clones (EIP-1167)
```

## Deployment Order

1. Deploy implementations (IdentityRegistry, CredentialRegistry, TrustedIssuerRegistry)
2. Deploy factories
3. Create registry instances via factories
4. Deploy CredentialRegistryIdentityValidator
5. Deploy Vault with forwarder address
6. Configure validator sources and requirements
7. Set validator in Vault

---

# 9️⃣ Key Events

## Vault Events

```solidity
event DepositCreated(
    uint256 indexed paymentId,
    address indexed sender,
    uint256 totalAmount,
    uint256 recipientCount,
    TokenType tokenType,
    address tokenAddress,
    uint8 auditMask
);

event PaymentReleased(uint256 indexed paymentId, address indexed sender);
event PaymentFrozen(uint256 indexed paymentId, address indexed sender);
event PaymentRefunded(uint256 indexed paymentId, address indexed sender);
event ComplianceResultAnchored(uint256 indexed paymentId, bytes32 resultHash, uint8 finalDecision, uint256 timestamp);
```

## Registry Events

```solidity
event IdentityRegistered(bytes32 indexed ccid, address indexed account);
event IdentityRemoved(bytes32 indexed ccid, address indexed account);
event CredentialRegistered(bytes32 indexed ccid, bytes32 indexed credentialTypeId, uint40 expiresAt, bytes credentialData);
event CredentialRemoved(bytes32 indexed ccid, bytes32 indexed credentialTypeId);
event TrustedIssuerAdded(bytes32 indexed issuerIdHash, string issuerId);
event TrustedIssuerRemoved(bytes32 indexed issuerIdHash, string issuerId);
```

---

# 🔟 Architecture Properties

- ✅ **Multi-token support** (ETH + ERC20)
- ✅ **Batch payments** (1→N recipients)
- ✅ **Configurable compliance** (auditMask)
- ✅ **Automated settlement** (Chainlink CRE)
- ✅ **Cross-chain identity** (CCID)
- ✅ **Dual-layer audit** (off-chain + on-chain)
- ✅ **Gas optimized** (EIP-1167 proxies, hash-only on-chain)
- ✅ **Tamper-evident** (immutable hash anchor)
- ✅ **Modular credentials** (KYC, AML, Sanctions, WorldID)
- ✅ **No PII on-chain** (only hashes)

---

# Summary

This architecture provides:

- **Automated compliance settlement** via Chainlink CRE
- **Cross-chain identity portability** via CCID
- **Flexible credential management** with expiration
- **Transparent audit trail** with dual-layer verification
- **Gas-efficient deployment** using proxy pattern
- **Secure settlement** with owner/CRE dual control
