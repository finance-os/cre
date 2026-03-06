# 🏦 Compliance Vault - Chainlink CRE Integration

A compliance-first payment escrow system with Cross-Chain Identity (CCID) verification and Chainlink CRE (Chainlink Runtime Environment) integration for automated settlement.

## 🌟 Overview

**System Flow:**

```
User Deposit (ETH/ERC20) → CRE Compliance Check → Settlement (Release/Freeze/Refund) → Audit
```

## 🏗️ Architecture

### Core Components

| Component                   | Description                                                          |
| --------------------------- | -------------------------------------------------------------------- |
| **Vault**                   | Main escrow contract holding funds and managing payment lifecycle    |
| **Identity Registry**       | Maps blockchain addresses to Cross-Chain IDs (CCID)                  |
| **Credential Registry**     | Manages credentials (KYC, AML, Sanctions, WorldID) attached to CCIDs |
| **Trusted Issuer Registry** | Manages trusted credential issuers                                   |
| **Identity Validator**      | Validates identities based on credential requirements                |
| **ReceiverTemplate**        | Enables Chainlink CRE integration for automated settlement           |

### Key Features

- ✅ **Multi-Token Support**: Both ETH and any ERC20 tokens
- ✅ **Batch Payments**: One sender → multiple recipients in a single transaction
- ✅ **Configurable Compliance**: Selective checks via `auditMask` bitmask
- ✅ **Automated Settlement**: Chainlink CRE integration for automatic release/freeze
- ✅ **Dual-Layer Audit**: Off-chain details + on-chain hash verification
- ✅ **Cross-Chain Identity**: CCID enables identity portability across chains

## 📁 Project Structure

```
finance-os-cre/
├── cre/                          # Chainlink CRE workflow
│   ├── main.ts                   # Workflow entry point
│   ├── flow.ts                   # Core flow logic
│   ├── runtime.ts                # Runtime utilities
│   ├── types.ts                  # TypeScript type definitions
│   └── contracts.ts              # Contract ABIs and interactions
├── examples/                     # Examples and demos
├── architecture.md               # Detailed architecture documentation
├── compliance-vault-cre-spec.md  # CRE workflow specification
├── test.ts                       # Test implementation
└── README.md                     # This file
```

## 🔄 CRE Workflow

```
┌─────────────────┐
│  DepositCreated │◄── Trigger from Vault (evmLog)
│     Event       │
└────────┬────────┘
         ▼
┌─────────────────┐
│   Read Payment  │◄── Get info from Vault
│   from Vault    │
└────────┬────────┘
         ▼
┌─────────────────┐
│ Compliance      │◄── Evaluate KYC/AML/SANCTIONS/WORLD_ID
│    Check        │    based on auditMask
└────────┬────────┘
         ▼
┌─────────────────┐
│   Decision      │◄── RELEASE if all pass, FROZEN if any fail
│                 │
└────────┬────────┘
         ▼
┌─────────────────┐
│  Anchor Hash    │◄── Store compliance hash on-chain
│   On-chain      │
└────────┬────────┘
         ▼
┌─────────────────┐
│   Settlement    │◄── Call release() if RELEASED
│                 │
└─────────────────┘
```

### Audit Mask

Each payment has an `auditMask` defining which compliance checks are required:

| Bit | Value | Credential | Check Scope             |
| --- | ----- | ---------- | ----------------------- |
| 0   | 1     | KYC        | Sender + All Recipients |
| 1   | 2     | AML        | Sender + All Recipients |
| 2   | 4     | SANCTIONS  | Sender + All Recipients |
| 3   | 8     | WORLD_ID   | Sender only             |

**Examples:**

- `auditMask = 3` → KYC + AML
- `auditMask = 7` → KYC + AML + SANCTIONS
- `auditMask = 15` → All checks

## 🔌 Deployed Contracts (Sepolia)

| Contract               | Address                                      |
| ---------------------- | -------------------------------------------- |
| Vault                  | `0x2E614177DA50A4d29c3ca98E1c45e1D7ab8bf253` |
| Identity Registry      | `0x1FE30a35fEA66c75f4c259862a2968460cbE35F6` |
| KYC Registry           | `0x3f8208211647D17a99Ec6458c15f00b6458263B8` |
| AML Registry           | `0xFE701E9a8DB3Cd331d3cdF8A6bD37a40c9C2FBD8` |
| Sanctions Registry     | `0x173dea57E159EB1B4ED0bC38dfA050E452f5C64d` |
| WorldID Registry       | `0x06c1d3D73C58044FaC4A62e3429C31A80818c1CB` |
| Forwarder (Mock)       | `0x15fC6ae953E024d975e77382eEeC56A9101f9F88` |
| Forwarder (Production) | `0xF8344CFd5c43616a4366C34E3EEE75af79a74482` |

## 🚀 Usage

### Requirements

- Node.js ≥ 18
- TypeScript
- Chainlink CRE CLI

### Installation

```bash
# Clone repository
git clone <repository-url>
cd finance-os-cre

# Install dependencies
npm install
```

### Running the Workflow

```bash
# Dry run (no on-chain writes)
cre run --config cre/config.dry_run.json

# Execute mode (real on-chain writes)
cre run --config cre/config.execute.json
```

### Simulation

```bash
# Simulation with specific transaction hash
cre simulate \
  --config cre/config.simulation.json \
  --evm-tx-hash <tx_hash> \
  --evm-event-index <event_index>
```

## 🧪 Testing

```bash
# Run test.ts
npx ts-node test.ts
```

## 🔒 Security Model

### Access Control

| Contract              | Action                       | Access                              |
| --------------------- | ---------------------------- | ----------------------------------- |
| Vault                 | release/freeze/refund/anchor | Owner or CRE (via ReceiverTemplate) |
| IdentityRegistry      | register/remove              | Owner                               |
| CredentialRegistry    | register/remove/renew        | Owner                               |
| TrustedIssuerRegistry | add/remove                   | Owner                               |

### Trust Assumptions

1. **Owner**: Trusted to manage registries and settlement
2. **CRE**: Trusted to evaluate compliance correctly (verifiable via hash)
3. **Backend**: Trusted to store off-chain details (verifiable against on-chain hash)

## 📋 Cross-Chain Identity Flow

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

## 📄 Documentation

- [architecture.md](architecture.md) - Detailed architecture documentation
- [compliance-vault-cre-spec.md](compliance-vault-cre-spec.md) - CRE workflow specification

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Create a Pull Request

## 📜 License

[License Type] - See [LICENSE](LICENSE) for details.

---

<p align="center">
  <i>Built with ❤️ for secure and compliant cross-chain payments</i>
</p>
