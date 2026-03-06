import type { Address } from "viem";

export type RunMode = "execute" | "dry_run";
export type TokenTypeLabel = "ETH" | "ERC20";
export type FinalDecision = "RELEASED" | "FROZEN";
export type EvmConfidence =
  | "CONFIDENCE_LEVEL_FINALIZED"
  | "CONFIDENCE_LEVEL_SAFE";

export interface EvmLogTriggerConfig {
  enabled: boolean;
  chainSelectorName: string;
  isTestnet: boolean;
  addresses: Address[];
  topics: string[];
  confidence: EvmConfidence;
}

export interface TriggerConfig {
  evmLog: EvmLogTriggerConfig;
}

export interface ContractConfig {
  vault: Address;
  identityRegistry: Address;
  kycRegistry: Address;
  amlRegistry: Address;
  sanctionRegistry: Address;
  worldidRegistry: Address;
}

export interface ExecutionConfig {
  runMode: RunMode;
}

export interface BackendConfig {
  enabled: boolean;
  url: string;
}

export interface WorkflowConfig {
  strategyId: string;
  workflowVersion: string;
  chainSelectorName: string;
  isTestnet: boolean;
  contracts: ContractConfig;
  trigger: TriggerConfig;
  execution: ExecutionConfig;
  backend?: BackendConfig;
}

export interface ComplianceCheck {
  checked: boolean;
  passed: boolean | null;
  reason?: string;
}

export interface SenderCompliance {
  address: Address;
  checks: {
    kyc: ComplianceCheck;
    aml: ComplianceCheck;
    sanctions: ComplianceCheck;
    worldId: ComplianceCheck;
  };
  overallResult: "PASS" | "FAIL";
}

export interface RecipientCompliance {
  address: Address;
  amountWei: bigint;
  checks: {
    kyc: ComplianceCheck;
    aml: ComplianceCheck;
    sanctions: ComplianceCheck;
  };
  result: "PASS" | "FAIL";
}

const ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;
const TOPIC_REGEX = /^0x[a-fA-F0-9]{64}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const parseNonEmptyString = (value: unknown, path: string): string => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Invalid "${path}": expected non-empty string`);
  }
  return value;
};

const parseOptionalNonEmptyString = (
  value: unknown,
  path: string
): string | undefined => {
  if (value === undefined) return undefined;
  return parseNonEmptyString(value, path);
};

const parseAddress = (value: unknown, path: string): Address => {
  if (typeof value !== "string" || !ADDRESS_REGEX.test(value)) {
    throw new Error(`Invalid "${path}": expected 0x-prefixed 20-byte hex address`);
  }
  return value as Address;
};

const parseBoolean = (value: unknown, path: string): boolean => {
  if (typeof value !== "boolean") {
    throw new Error(`Invalid "${path}": expected boolean`);
  }
  return value;
};

const parseStringArray = (value: unknown, path: string): string[] => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Invalid "${path}": expected non-empty string[]`);
  }
  return value.map((entry, index) => parseNonEmptyString(entry, `${path}[${index}]`));
};

const parseAddressArray = (value: unknown, path: string): Address[] => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Invalid "${path}": expected non-empty address[]`);
  }
  return value.map((entry, index) => parseAddress(entry, `${path}[${index}]`));
};

const parseTopics = (value: unknown, path: string): string[] => {
  const topics = parseStringArray(value, path);
  topics.forEach((topic, index) => {
    if (!TOPIC_REGEX.test(topic)) {
      throw new Error(`Invalid "${path}[${index}]": expected 0x-prefixed 32-byte topic`);
    }
  });
  return topics;
};

const parseConfidence = (value: unknown, path: string): EvmConfidence => {
  if (value === "CONFIDENCE_LEVEL_FINALIZED" || value === "CONFIDENCE_LEVEL_SAFE") {
    return value;
  }
  throw new Error(
    `Invalid "${path}": expected "CONFIDENCE_LEVEL_FINALIZED" or "CONFIDENCE_LEVEL_SAFE"`
  );
};

const parseRunMode = (value: unknown, path: string): RunMode => {
  if (value === "execute" || value === "dry_run") {
    return value;
  }
  throw new Error(`Invalid "${path}": expected "execute" or "dry_run"`);
};

const parseBackendConfig = (value: unknown): BackendConfig | undefined => {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error('Invalid config at "backend": expected object');
  }
  return {
    enabled: parseBoolean(value.enabled, "backend.enabled"),
    url: parseNonEmptyString(value.url, "backend.url"),
  };
};

export const parseWorkflowConfig = (value: unknown): WorkflowConfig => {
  if (!isRecord(value)) {
    throw new Error("Invalid config: expected object");
  }
  const contractsRaw = value.contracts;
  if (!isRecord(contractsRaw)) {
    throw new Error('Invalid config at "contracts": expected object');
  }
  const triggerRaw = value.trigger;
  if (!isRecord(triggerRaw)) {
    throw new Error('Invalid config at "trigger": expected object');
  }
  const evmLogRaw = triggerRaw.evmLog;
  if (!isRecord(evmLogRaw)) {
    throw new Error('Invalid config at "trigger.evmLog": expected object');
  }
  const executionRaw = value.execution;
  if (!isRecord(executionRaw)) {
    throw new Error('Invalid config at "execution": expected object');
  }

  const workflowVersion =
    parseOptionalNonEmptyString(value.workflowVersion, "workflowVersion") ??
    "0.2.0-ccid";

  return {
    strategyId: parseNonEmptyString(value.strategyId, "strategyId"),
    workflowVersion,
    chainSelectorName: parseNonEmptyString(value.chainSelectorName, "chainSelectorName"),
    isTestnet: parseBoolean(value.isTestnet, "isTestnet"),
    contracts: {
      vault: parseAddress(contractsRaw.vault, "contracts.vault"),
      identityRegistry: parseAddress(
        contractsRaw.identityRegistry,
        "contracts.identityRegistry"
      ),
      kycRegistry: parseAddress(contractsRaw.kycRegistry, "contracts.kycRegistry"),
      amlRegistry: parseAddress(contractsRaw.amlRegistry, "contracts.amlRegistry"),
      sanctionRegistry: parseAddress(
        contractsRaw.sanctionRegistry,
        "contracts.sanctionRegistry"
      ),
      worldidRegistry: parseAddress(
        contractsRaw.worldidRegistry,
        "contracts.worldidRegistry"
      ),
    },
    trigger: {
      evmLog: {
        enabled: parseBoolean(evmLogRaw.enabled, "trigger.evmLog.enabled"),
        chainSelectorName: parseNonEmptyString(
          evmLogRaw.chainSelectorName,
          "trigger.evmLog.chainSelectorName"
        ),
        isTestnet: parseBoolean(evmLogRaw.isTestnet, "trigger.evmLog.isTestnet"),
        addresses: parseAddressArray(evmLogRaw.addresses, "trigger.evmLog.addresses"),
        topics: parseTopics(evmLogRaw.topics, "trigger.evmLog.topics"),
        confidence: parseConfidence(evmLogRaw.confidence, "trigger.evmLog.confidence"),
      },
    },
    execution: {
      runMode: parseRunMode(executionRaw.runMode, "execution.runMode"),
    },
    backend: parseBackendConfig(value.backend),
  };
};
