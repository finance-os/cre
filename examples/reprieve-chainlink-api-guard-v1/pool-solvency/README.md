# Workflow Template

This is a template for creating new CRE workflows.

## Quick Start

```bash
# 1. Copy this directory
cp -r workflow-template my-new-workflow

# 2. Update workflow.yaml
# Change 'workflow-name' from "tapfun-workflow-template" to your workflow name

# 3. Update config.json
# Add your contract addresses and API endpoints

# 4. Implement your logic in main.ts

# 5. Run simulation
cre workflow simulate my-new-workflow --target local-simulation
```

## Files

| File | Purpose |
|------|---------|
| `main.ts` | Workflow entry point and handler |
| `types.ts` | TypeScript types and Zod schemas |
| `config.json` | Runtime configuration (API URLs, contract addresses) |
| `workflow.yaml` | CRE workflow settings per environment |
| `lib/hash.ts` | Hashing utilities (copied from price-integrity) |
| `lib/ethereum.ts` | EVM interaction helpers |

## Common Tasks

### Change Cron Schedule

```typescript
// In main.ts, inside initWorkflow:
const cronTrigger = new CronCapability().trigger({
  schedule: "0 * * * *",  // Every hour
});
```

### Add API Client

Copy and adapt from `price-integrity/lib/api.ts`:

```typescript
import { createApiClient } from "./lib/api";

// In handler:
const apiClient = createApiClient(
  runtime.config.appApiBaseUrl,
  "api-key",
  false  // useMock
);
const data = await apiClient.getSomeData();
```

### Submit On-Chain Transaction

```typescript
import { writeContract } from "./lib/ethereum";
import { getEvmConfig } from "./types";

// In handler:
const evmConfig = getEvmConfig(runtime.config);

const txHash = writeContract(runtime, evmConfig, {
  contractAddress: evmConfig.contractAddress,
  abi: ["function myFunction(uint256 value)"],
  functionName: "myFunction",
  args: [123n],
});
```

## Testing

```bash
# TypeScript compilation
bun run build

# Simulation
cre workflow simulate my-new-workflow --target local-simulation

# Verbose simulation
cre workflow simulate my-new-workflow --target local-simulation -v
```

## Troubleshooting

See `../AGENTS.md` for common pitfalls and solutions.
