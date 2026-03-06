export type StrategyId =
  | "CHAINLINK_API_GUARD_V1"
  | "QUANT_FUNDING_OI_V1"
  | "QUANT_BASIS_LIQUIDITY_V1";

export type TriggerKind = "http" | "evm_log" | "cron";

export type RescueDecision =
  | "NO_ACTION"
  | "RESCUE_SAME_CHAIN"
  | "RESCUE_CROSS_CHAIN"
  | "ABORT";

export type SettlementState =
  | "NONE"
  | "DISPATCHED"
  | "DELIVERED_SUCCESS"
  | "DELIVERED_FAILED"
  | "TIMEOUT";

export interface HttpTriggerConfig {
  enabled: boolean;
  authorizedKeys: string[];
}

export interface EvmLogTriggerConfig {
  enabled: boolean;
  chainSelectorName: string;
  isTestnet: boolean;
  addresses: string[];
  topics: string[];
  confidence: "CONFIDENCE_LEVEL_FINALIZED" | "CONFIDENCE_LEVEL_SAFE";
}

export interface CronTriggerConfig {
  enabled: boolean;
  schedule: string;
}

export interface TriggerConfig {
  http: HttpTriggerConfig;
  evmLog: EvmLogTriggerConfig;
  cron: CronTriggerConfig;
}

export interface ContractConfig {
  rescueExecutor: string;
  rescueReporter: string;
  workflowReceiver?: string;
  ccipReceiver: string;
}

export interface BaseWorkflowConfig {
  strategyId: StrategyId;
  workflowVersion: string;
  chainSelectorName: string;
  isTestnet: boolean;
  contracts: ContractConfig;
  trigger: TriggerConfig;
}

export interface RiskBudgetConfig {
  maxNativeFeeWei: string;
  maxRescueNotionalUsd: number;
}

export interface RescuePolicyConfig {
  defaultMode: "TOP_UP" | "REPAY";
  allowCrossChain: boolean;
  reserveCapBps: number;
  minActionUsd: number;
  targetHfBps?: number;
}

export interface CrossChainConfig {
  sourceChainSelector: string;
  destinationChainSelector: string;
  deliveryTimeoutSec: number;
}

export interface MonitoredAdapterConfig {
  label: string;
  adapterAddress: string;
  chainSelectorName?: string;
  isTestnet?: boolean;
  rescueTargetChainSelector?: string;
}

export interface MonitoringConfig {
  defaultUser: string;
  adapters: MonitoredAdapterConfig[];
  abortOnMissingPrice: boolean;
  priceShockAbortBps: number;
}

export interface ChainlinkApiSourceConfig {
  priceApiBaseUrl: string;
  priceApiPath: string;
  maxPriceAgeSec: number;
  stalePolicy?: "ABORT" | "WARN_ONLY";
  crossChainAssetMap?: Record<string, string>;
  integritySalt: string;
  positionsApiBaseUrl?: string;
  positionsApiPath?: string;
  positionsApiKey?: string;
  positionsApiMaxAgeSec?: number;
  preferOnchainOracle?: boolean;
  mockOracleAddress?: string;
  mockPricesUsd: Record<string, string>;
}

export interface QuantFundingOiSourceConfig {
  binanceFundingUrl: string;
  bybitFundingUrl: string;
  binanceOiUrl: string;
  bybitOiUrl: string;
  fundingWeightBps: number;
  oiWeightBps: number;
  divergenceWeightBps: number;
}

export interface QuantBasisLiquiditySourceConfig {
  basisApiUrl: string;
  oiHistoryApiUrl: string;
  takerFlowApiUrl: string;
  basisWeightBps: number;
  liquidityWeightBps: number;
  takerFlowWeightBps: number;
}

export interface ChainlinkApiGuardThresholds {
  onchainHfMinBps: number;
  earlyWarningHfBps: number;
  stalePricePenaltyBps: number;
  slopePenaltyBps: number;
}

export interface QuantFundingOiThresholds {
  onchainHfMinBps: number;
  earlyWarningHfBps: number;
  fundingStressBps: number;
  oiStressBps: number;
  venueDivergencePenaltyBps: number;
}

export interface QuantBasisLiquidityThresholds {
  onchainHfMinBps: number;
  earlyWarningHfBps: number;
  basisStressBps: number;
  liquidityStressBps: number;
  takerImbalanceBps: number;
  regimeExtremeBps: number;
}

export interface ChainlinkApiGuardConfig extends BaseWorkflowConfig {
  strategyId: "CHAINLINK_API_GUARD_V1";
  thresholds: ChainlinkApiGuardThresholds;
  budget: RiskBudgetConfig;
  rescue: RescuePolicyConfig;
  crossChain: CrossChainConfig;
  monitoring: MonitoringConfig;
  dataSources: {
    chainlinkApi: ChainlinkApiSourceConfig;
  };
}

export interface QuantFundingOiConfig extends BaseWorkflowConfig {
  strategyId: "QUANT_FUNDING_OI_V1";
  thresholds: QuantFundingOiThresholds;
  budget: RiskBudgetConfig;
  rescue: RescuePolicyConfig;
  crossChain: CrossChainConfig;
  dataSources: {
    chainlinkApi: ChainlinkApiSourceConfig;
    quantFundingOi: QuantFundingOiSourceConfig;
  };
}

export interface QuantBasisLiquidityConfig extends BaseWorkflowConfig {
  strategyId: "QUANT_BASIS_LIQUIDITY_V1";
  thresholds: QuantBasisLiquidityThresholds;
  budget: RiskBudgetConfig;
  rescue: RescuePolicyConfig;
  crossChain: CrossChainConfig;
  dataSources: {
    chainlinkApi: ChainlinkApiSourceConfig;
    quantFundingOi: QuantFundingOiSourceConfig;
    quantBasisLiquidity: QuantBasisLiquiditySourceConfig;
  };
}

export type ProfileWorkflowConfig =
  | ChainlinkApiGuardConfig
  | QuantFundingOiConfig
  | QuantBasisLiquidityConfig;

export interface TxReference {
  chainSelectorName: string;
  txHash: string;
  label: string;
}

export interface ExecutionEnvelope {
  executionId: string;
  strategyId: StrategyId;
  trigger: TriggerKind;
  decision: RescueDecision;
  reason: string;
  settlementState: SettlementState;
  txRefs: TxReference[];
  metadata: Record<string, string | number | boolean>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const requireString = (value: unknown, path: string): string => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Invalid config at "${path}": expected non-empty string`);
  }
  return value;
};

const requireBoolean = (value: unknown, path: string): boolean => {
  if (typeof value !== "boolean") {
    throw new Error(`Invalid config at "${path}": expected boolean`);
  }
  return value;
};

const requireNumber = (
  value: unknown,
  path: string,
  minInclusive?: number,
  maxInclusive?: number
): number => {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(`Invalid config at "${path}": expected number`);
  }
  if (minInclusive !== undefined && value < minInclusive) {
    throw new Error(`Invalid config at "${path}": expected >= ${minInclusive}`);
  }
  if (maxInclusive !== undefined && value > maxInclusive) {
    throw new Error(`Invalid config at "${path}": expected <= ${maxInclusive}`);
  }
  return value;
};

const requireStringArray = (value: unknown, path: string): string[] => {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid config at "${path}": expected string[]`);
  }
  const result: string[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const itemPath = `${path}[${i}]`;
    result.push(requireString(value[i], itemPath));
  }
  return result;
};

const parseStringNumberMap = (value: unknown, path: string): Record<string, string> => {
  if (!isRecord(value)) {
    throw new Error(`Invalid config at "${path}": expected object map`);
  }

  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== "string" || raw.trim() === "") {
      throw new Error(`Invalid config at "${path}.${key}": expected non-empty string`);
    }
    out[key.toLowerCase()] = raw;
  }
  return out;
};

const parseHttpTriggerConfig = (value: unknown): HttpTriggerConfig => {
  if (!isRecord(value)) {
    throw new Error('Invalid config at "trigger.http": expected object');
  }
  return {
    enabled: requireBoolean(value.enabled, "trigger.http.enabled"),
    authorizedKeys: requireStringArray(
      value.authorizedKeys,
      "trigger.http.authorizedKeys"
    ),
  };
};

const parseEvmLogTriggerConfig = (value: unknown): EvmLogTriggerConfig => {
  if (!isRecord(value)) {
    throw new Error('Invalid config at "trigger.evmLog": expected object');
  }

  const confidence = requireString(value.confidence, "trigger.evmLog.confidence");
  if (
    confidence !== "CONFIDENCE_LEVEL_FINALIZED" &&
    confidence !== "CONFIDENCE_LEVEL_SAFE"
  ) {
    throw new Error(
      'Invalid config at "trigger.evmLog.confidence": unsupported confidence level'
    );
  }

  return {
    enabled: requireBoolean(value.enabled, "trigger.evmLog.enabled"),
    chainSelectorName: requireString(
      value.chainSelectorName,
      "trigger.evmLog.chainSelectorName"
    ),
    isTestnet: requireBoolean(value.isTestnet, "trigger.evmLog.isTestnet"),
    addresses: requireStringArray(value.addresses, "trigger.evmLog.addresses"),
    topics: requireStringArray(value.topics, "trigger.evmLog.topics"),
    confidence,
  };
};

const parseCronTriggerConfig = (value: unknown): CronTriggerConfig => {
  if (!isRecord(value)) {
    throw new Error('Invalid config at "trigger.cron": expected object');
  }
  return {
    enabled: requireBoolean(value.enabled, "trigger.cron.enabled"),
    schedule: requireString(value.schedule, "trigger.cron.schedule"),
  };
};

const parseContracts = (value: unknown): ContractConfig => {
  if (!isRecord(value)) {
    throw new Error('Invalid config at "contracts": expected object');
  }
  return {
    rescueExecutor: requireString(value.rescueExecutor, "contracts.rescueExecutor"),
    rescueReporter: requireString(value.rescueReporter, "contracts.rescueReporter"),
    workflowReceiver:
      value.workflowReceiver === undefined
        ? undefined
        : requireString(value.workflowReceiver, "contracts.workflowReceiver"),
    ccipReceiver: requireString(value.ccipReceiver, "contracts.ccipReceiver"),
  };
};

const parseTriggerConfig = (value: unknown): TriggerConfig => {
  if (!isRecord(value)) {
    throw new Error('Invalid config at "trigger": expected object');
  }
  return {
    http: parseHttpTriggerConfig(value.http),
    evmLog: parseEvmLogTriggerConfig(value.evmLog),
    cron: parseCronTriggerConfig(value.cron),
  };
};

const parseRiskBudget = (value: unknown): RiskBudgetConfig => {
  if (!isRecord(value)) {
    throw new Error('Invalid config at "budget": expected object');
  }

  const maxNativeFeeWei = requireString(value.maxNativeFeeWei, "budget.maxNativeFeeWei");
  if (!/^\d+$/.test(maxNativeFeeWei)) {
    throw new Error('Invalid config at "budget.maxNativeFeeWei": expected integer string');
  }

  return {
    maxNativeFeeWei,
    maxRescueNotionalUsd: requireNumber(
      value.maxRescueNotionalUsd,
      "budget.maxRescueNotionalUsd",
      1
    ),
  };
};

const parseRescuePolicy = (value: unknown): RescuePolicyConfig => {
  if (!isRecord(value)) {
    throw new Error('Invalid config at "rescue": expected object');
  }

  const defaultMode = requireString(value.defaultMode, "rescue.defaultMode");
  if (defaultMode !== "TOP_UP" && defaultMode !== "REPAY") {
    throw new Error('Invalid config at "rescue.defaultMode": expected TOP_UP or REPAY');
  }

  return {
    defaultMode,
    allowCrossChain: requireBoolean(value.allowCrossChain, "rescue.allowCrossChain"),
    reserveCapBps: requireNumber(value.reserveCapBps, "rescue.reserveCapBps", 1, 10000),
    minActionUsd:
      value.minActionUsd === undefined
        ? 0
        : requireNumber(value.minActionUsd, "rescue.minActionUsd", 0),
    targetHfBps:
      value.targetHfBps === undefined
        ? undefined
        : requireNumber(value.targetHfBps, "rescue.targetHfBps", 10000),
  };
};

const parseCrossChain = (value: unknown): CrossChainConfig => {
  if (!isRecord(value)) {
    throw new Error('Invalid config at "crossChain": expected object');
  }
  return {
    sourceChainSelector: requireString(
      value.sourceChainSelector,
      "crossChain.sourceChainSelector"
    ),
    destinationChainSelector: requireString(
      value.destinationChainSelector,
      "crossChain.destinationChainSelector"
    ),
    deliveryTimeoutSec: requireNumber(
      value.deliveryTimeoutSec,
      "crossChain.deliveryTimeoutSec",
      30
    ),
  };
};

const parseMonitoredAdapter = (value: unknown, path: string): MonitoredAdapterConfig => {
  if (!isRecord(value)) {
    throw new Error(`Invalid config at "${path}": expected object`);
  }

  return {
    label: requireString(value.label, `${path}.label`),
    adapterAddress: requireString(value.adapterAddress, `${path}.adapterAddress`),
    chainSelectorName:
      value.chainSelectorName === undefined
        ? undefined
        : requireString(value.chainSelectorName, `${path}.chainSelectorName`),
    isTestnet:
      value.isTestnet === undefined
        ? undefined
        : requireBoolean(value.isTestnet, `${path}.isTestnet`),
    rescueTargetChainSelector:
      value.rescueTargetChainSelector === undefined
        ? undefined
        : requireString(value.rescueTargetChainSelector, `${path}.rescueTargetChainSelector`),
  };
};

const parseMonitoring = (value: unknown): MonitoringConfig => {
  if (!isRecord(value)) {
    throw new Error('Invalid config at "monitoring": expected object');
  }

  const adaptersRaw = value.adapters;
  if (!Array.isArray(adaptersRaw) || adaptersRaw.length === 0) {
    throw new Error('Invalid config at "monitoring.adapters": expected non-empty array');
  }

  const adapters = adaptersRaw.map((item, idx) =>
    parseMonitoredAdapter(item, `monitoring.adapters[${idx}]`)
  );

  return {
    defaultUser: requireString(value.defaultUser, "monitoring.defaultUser"),
    adapters,
    abortOnMissingPrice: requireBoolean(
      value.abortOnMissingPrice,
      "monitoring.abortOnMissingPrice"
    ),
    priceShockAbortBps: requireNumber(
      value.priceShockAbortBps,
      "monitoring.priceShockAbortBps",
      0,
      10000
    ),
  };
};

const parseChainlinkApiSource = (value: unknown): ChainlinkApiSourceConfig => {
  if (!isRecord(value)) {
    throw new Error('Invalid config at "dataSources.chainlinkApi": expected object');
  }

  const stalePolicyRaw =
    value.stalePolicy === undefined
      ? "ABORT"
      : requireString(value.stalePolicy, "dataSources.chainlinkApi.stalePolicy");
  if (stalePolicyRaw !== "ABORT" && stalePolicyRaw !== "WARN_ONLY") {
    throw new Error(
      'Invalid config at "dataSources.chainlinkApi.stalePolicy": expected ABORT or WARN_ONLY'
    );
  }

  const crossChainAssetMapRaw = value.crossChainAssetMap;
  const crossChainAssetMap: Record<string, string> = {};
  if (crossChainAssetMapRaw !== undefined) {
    if (!isRecord(crossChainAssetMapRaw)) {
      throw new Error(
        'Invalid config at "dataSources.chainlinkApi.crossChainAssetMap": expected object map'
      );
    }
    for (const [fromAsset, toAssetRaw] of Object.entries(crossChainAssetMapRaw)) {
      if (typeof toAssetRaw !== "string" || toAssetRaw.trim().length === 0) {
        throw new Error(
          `Invalid config at "dataSources.chainlinkApi.crossChainAssetMap.${fromAsset}": expected non-empty string`
        );
      }
      crossChainAssetMap[fromAsset.toLowerCase()] = toAssetRaw.toLowerCase();
    }
  }

  return {
    priceApiBaseUrl: requireString(
      value.priceApiBaseUrl,
      "dataSources.chainlinkApi.priceApiBaseUrl"
    ),
    priceApiPath: requireString(
      value.priceApiPath,
      "dataSources.chainlinkApi.priceApiPath"
    ),
    maxPriceAgeSec: requireNumber(
      value.maxPriceAgeSec,
      "dataSources.chainlinkApi.maxPriceAgeSec",
      0
    ),
    stalePolicy: stalePolicyRaw,
    crossChainAssetMap,
    integritySalt: requireString(
      value.integritySalt,
      "dataSources.chainlinkApi.integritySalt"
    ),
    positionsApiBaseUrl:
      value.positionsApiBaseUrl === undefined
        ? undefined
        : requireString(
            value.positionsApiBaseUrl,
            "dataSources.chainlinkApi.positionsApiBaseUrl"
          ),
    positionsApiPath:
      value.positionsApiPath === undefined
        ? undefined
        : requireString(
            value.positionsApiPath,
            "dataSources.chainlinkApi.positionsApiPath"
          ),
    positionsApiKey:
      value.positionsApiKey === undefined
        ? undefined
        : requireString(
            value.positionsApiKey,
            "dataSources.chainlinkApi.positionsApiKey"
          ),
    positionsApiMaxAgeSec:
      value.positionsApiMaxAgeSec === undefined
        ? undefined
        : requireNumber(
            value.positionsApiMaxAgeSec,
            "dataSources.chainlinkApi.positionsApiMaxAgeSec",
            1
          ),
    preferOnchainOracle:
      value.preferOnchainOracle === undefined
        ? undefined
        : requireBoolean(
            value.preferOnchainOracle,
            "dataSources.chainlinkApi.preferOnchainOracle"
          ),
    mockOracleAddress:
      value.mockOracleAddress === undefined
        ? undefined
        : requireString(
            value.mockOracleAddress,
            "dataSources.chainlinkApi.mockOracleAddress"
          ),
    mockPricesUsd:
      value.mockPricesUsd === undefined
        ? {}
        : parseStringNumberMap(
            value.mockPricesUsd,
            "dataSources.chainlinkApi.mockPricesUsd"
          ),
  };
};

const parseQuantFundingOiSource = (
  value: unknown
): QuantFundingOiSourceConfig => {
  if (!isRecord(value)) {
    throw new Error('Invalid config at "dataSources.quantFundingOi": expected object');
  }

  const fundingWeightBps = requireNumber(
    value.fundingWeightBps,
    "dataSources.quantFundingOi.fundingWeightBps",
    1,
    10000
  );
  const oiWeightBps = requireNumber(
    value.oiWeightBps,
    "dataSources.quantFundingOi.oiWeightBps",
    1,
    10000
  );
  const divergenceWeightBps = requireNumber(
    value.divergenceWeightBps,
    "dataSources.quantFundingOi.divergenceWeightBps",
    1,
    10000
  );

  if (fundingWeightBps + oiWeightBps + divergenceWeightBps !== 10000) {
    throw new Error(
      'Invalid config at "dataSources.quantFundingOi": weights must sum to 10000 bps'
    );
  }

  return {
    binanceFundingUrl: requireString(
      value.binanceFundingUrl,
      "dataSources.quantFundingOi.binanceFundingUrl"
    ),
    bybitFundingUrl: requireString(
      value.bybitFundingUrl,
      "dataSources.quantFundingOi.bybitFundingUrl"
    ),
    binanceOiUrl: requireString(
      value.binanceOiUrl,
      "dataSources.quantFundingOi.binanceOiUrl"
    ),
    bybitOiUrl: requireString(
      value.bybitOiUrl,
      "dataSources.quantFundingOi.bybitOiUrl"
    ),
    fundingWeightBps,
    oiWeightBps,
    divergenceWeightBps,
  };
};

const parseQuantBasisLiquiditySource = (
  value: unknown
): QuantBasisLiquiditySourceConfig => {
  if (!isRecord(value)) {
    throw new Error(
      'Invalid config at "dataSources.quantBasisLiquidity": expected object'
    );
  }

  const basisWeightBps = requireNumber(
    value.basisWeightBps,
    "dataSources.quantBasisLiquidity.basisWeightBps",
    1,
    10000
  );
  const liquidityWeightBps = requireNumber(
    value.liquidityWeightBps,
    "dataSources.quantBasisLiquidity.liquidityWeightBps",
    1,
    10000
  );
  const takerFlowWeightBps = requireNumber(
    value.takerFlowWeightBps,
    "dataSources.quantBasisLiquidity.takerFlowWeightBps",
    1,
    10000
  );

  if (basisWeightBps + liquidityWeightBps + takerFlowWeightBps !== 10000) {
    throw new Error(
      'Invalid config at "dataSources.quantBasisLiquidity": weights must sum to 10000 bps'
    );
  }

  return {
    basisApiUrl: requireString(
      value.basisApiUrl,
      "dataSources.quantBasisLiquidity.basisApiUrl"
    ),
    oiHistoryApiUrl: requireString(
      value.oiHistoryApiUrl,
      "dataSources.quantBasisLiquidity.oiHistoryApiUrl"
    ),
    takerFlowApiUrl: requireString(
      value.takerFlowApiUrl,
      "dataSources.quantBasisLiquidity.takerFlowApiUrl"
    ),
    basisWeightBps,
    liquidityWeightBps,
    takerFlowWeightBps,
  };
};

const parseChainlinkThresholds = (
  value: unknown
): ChainlinkApiGuardThresholds => {
  if (!isRecord(value)) {
    throw new Error('Invalid config at "thresholds": expected object');
  }
  return {
    onchainHfMinBps: requireNumber(value.onchainHfMinBps, "thresholds.onchainHfMinBps", 1),
    earlyWarningHfBps: requireNumber(
      value.earlyWarningHfBps,
      "thresholds.earlyWarningHfBps",
      1
    ),
    stalePricePenaltyBps: requireNumber(
      value.stalePricePenaltyBps,
      "thresholds.stalePricePenaltyBps",
      0,
      10000
    ),
    slopePenaltyBps: requireNumber(
      value.slopePenaltyBps,
      "thresholds.slopePenaltyBps",
      0,
      10000
    ),
  };
};

const parseFundingOiThresholds = (value: unknown): QuantFundingOiThresholds => {
  if (!isRecord(value)) {
    throw new Error('Invalid config at "thresholds": expected object');
  }
  return {
    onchainHfMinBps: requireNumber(value.onchainHfMinBps, "thresholds.onchainHfMinBps", 1),
    earlyWarningHfBps: requireNumber(
      value.earlyWarningHfBps,
      "thresholds.earlyWarningHfBps",
      1
    ),
    fundingStressBps: requireNumber(
      value.fundingStressBps,
      "thresholds.fundingStressBps",
      1,
      10000
    ),
    oiStressBps: requireNumber(value.oiStressBps, "thresholds.oiStressBps", 1, 10000),
    venueDivergencePenaltyBps: requireNumber(
      value.venueDivergencePenaltyBps,
      "thresholds.venueDivergencePenaltyBps",
      0,
      10000
    ),
  };
};

const parseBasisLiquidityThresholds = (
  value: unknown
): QuantBasisLiquidityThresholds => {
  if (!isRecord(value)) {
    throw new Error('Invalid config at "thresholds": expected object');
  }
  return {
    onchainHfMinBps: requireNumber(value.onchainHfMinBps, "thresholds.onchainHfMinBps", 1),
    earlyWarningHfBps: requireNumber(
      value.earlyWarningHfBps,
      "thresholds.earlyWarningHfBps",
      1
    ),
    basisStressBps: requireNumber(value.basisStressBps, "thresholds.basisStressBps", 1, 10000),
    liquidityStressBps: requireNumber(
      value.liquidityStressBps,
      "thresholds.liquidityStressBps",
      1,
      10000
    ),
    takerImbalanceBps: requireNumber(
      value.takerImbalanceBps,
      "thresholds.takerImbalanceBps",
      1,
      10000
    ),
    regimeExtremeBps: requireNumber(
      value.regimeExtremeBps,
      "thresholds.regimeExtremeBps",
      1,
      10000
    ),
  };
};

export const parseBaseWorkflowConfig = (raw: unknown): BaseWorkflowConfig => {
  if (!isRecord(raw)) {
    throw new Error("Invalid workflow config: expected object");
  }

  const strategyId = requireString(raw.strategyId, "strategyId");
  if (
    strategyId !== "CHAINLINK_API_GUARD_V1" &&
    strategyId !== "QUANT_FUNDING_OI_V1" &&
    strategyId !== "QUANT_BASIS_LIQUIDITY_V1"
  ) {
    throw new Error(
      'Invalid config at "strategyId": expected one of CHAINLINK_API_GUARD_V1, QUANT_FUNDING_OI_V1, QUANT_BASIS_LIQUIDITY_V1'
    );
  }

  return {
    strategyId,
    workflowVersion: requireString(raw.workflowVersion, "workflowVersion"),
    chainSelectorName: requireString(raw.chainSelectorName, "chainSelectorName"),
    isTestnet: requireBoolean(raw.isTestnet, "isTestnet"),
    contracts: parseContracts(raw.contracts),
    trigger: parseTriggerConfig(raw.trigger),
  };
};

const parseCommonProfileParts = (raw: Record<string, unknown>) => ({
  budget: parseRiskBudget(raw.budget),
  rescue: parseRescuePolicy(raw.rescue),
  crossChain: parseCrossChain(raw.crossChain),
});

export const parseProfileWorkflowConfig = (
  raw: unknown,
  expectedStrategy?: StrategyId
): ProfileWorkflowConfig => {
  if (!isRecord(raw)) {
    throw new Error("Invalid workflow config: expected object");
  }

  const base = parseBaseWorkflowConfig(raw);

  if (expectedStrategy && base.strategyId !== expectedStrategy) {
    throw new Error(
      `Workflow/profile mismatch: expected ${expectedStrategy}, got ${base.strategyId}`
    );
  }

  const dataSources = raw.dataSources;
  if (!isRecord(dataSources)) {
    throw new Error('Invalid config at "dataSources": expected object');
  }

  const common = parseCommonProfileParts(raw);

  switch (base.strategyId) {
    case "CHAINLINK_API_GUARD_V1":
      return {
        ...base,
        strategyId: "CHAINLINK_API_GUARD_V1",
        ...common,
        monitoring: parseMonitoring(raw.monitoring),
        thresholds: parseChainlinkThresholds(raw.thresholds),
        dataSources: {
          chainlinkApi: parseChainlinkApiSource(dataSources.chainlinkApi),
        },
      };

    case "QUANT_FUNDING_OI_V1":
      return {
        ...base,
        strategyId: "QUANT_FUNDING_OI_V1",
        ...common,
        thresholds: parseFundingOiThresholds(raw.thresholds),
        dataSources: {
          chainlinkApi: parseChainlinkApiSource(dataSources.chainlinkApi),
          quantFundingOi: parseQuantFundingOiSource(dataSources.quantFundingOi),
        },
      };

    case "QUANT_BASIS_LIQUIDITY_V1":
      return {
        ...base,
        strategyId: "QUANT_BASIS_LIQUIDITY_V1",
        ...common,
        thresholds: parseBasisLiquidityThresholds(raw.thresholds),
        dataSources: {
          chainlinkApi: parseChainlinkApiSource(dataSources.chainlinkApi),
          quantFundingOi: parseQuantFundingOiSource(dataSources.quantFundingOi),
          quantBasisLiquidity: parseQuantBasisLiquiditySource(
            dataSources.quantBasisLiquidity
          ),
        },
      };
  }
};

export const ensureStrategyId = (
  config: BaseWorkflowConfig,
  expected: StrategyId
): void => {
  if (config.strategyId !== expected) {
    throw new Error(
      `Workflow/profile mismatch: expected ${expected}, got ${config.strategyId}`
    );
  }
};

export const buildEnvelope = (
  input: Omit<ExecutionEnvelope, "settlementState" | "txRefs" | "metadata"> &
    Partial<Pick<ExecutionEnvelope, "settlementState" | "txRefs" | "metadata">>
): ExecutionEnvelope => ({
  ...input,
  settlementState: input.settlementState ?? "NONE",
  txRefs: input.txRefs ?? [],
  metadata: input.metadata ?? {},
});
