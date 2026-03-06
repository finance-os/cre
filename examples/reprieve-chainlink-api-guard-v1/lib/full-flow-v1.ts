import type { EVMLog, Runtime } from "@chainlink/cre-sdk";
import { keccak256, toBytes, type Address, type Hex } from "viem";
import { buildEnvelope, type ChainlinkApiGuardConfig, type ExecutionEnvelope } from "../types";
import {
  decodeCrossChainTerminalEvent,
  decodeReprieveEvent,
  readCcipMessageId,
  readFailedMessage,
  readRescueInProgress,
  readRescueStatus,
  readTokenDecimals,
  submitRescuePlanReport,
  type RescuePlanInput,
  type RescueStepInput,
} from "./contracts";
import { evaluateChainlinkApiGuard, parseUsdToWad, type AdapterSnapshot } from "./risk-v1";

const WAD = 10n ** 18n;
const BPS_DENOM = 10000n;
const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

type RunMode = "execute" | "monitor_only" | "dry_run";
type RescueModeLabel = "TOP_UP" | "REPAY";
type SourceCandidate = {
  source: FlatPosition;
  mode: RescueModeLabel;
};

type FlatPosition = {
  label: string;
  adapterAddress: Address;
  availableCollateral: bigint;
  chainId?: number;
  chainKey?: string;
  isConfiguredAdapter: boolean;
  rescueTargetChainSelector?: string;
  position: AdapterSnapshot["positions"][number];
};

const asAddress = (value: unknown): Address | undefined => {
  if (typeof value !== "string") return undefined;
  if (!/^0x[a-fA-F0-9]{40}$/.test(value)) return undefined;
  return value as Address;
};

const asBytes32 = (value: unknown): Hex | undefined => {
  if (typeof value !== "string") return undefined;
  if (!/^0x[a-fA-F0-9]{64}$/.test(value)) return undefined;
  return value as Hex;
};

const asBigInt = (value: unknown): bigint | undefined => {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return BigInt(Math.floor(value));
  }
  if (typeof value === "string" && /^[0-9]+$/.test(value)) {
    return BigInt(value);
  }
  return undefined;
};

const asGasLimit = (value: unknown): string | undefined => {
  const parsed = asBigInt(value);
  if (parsed === undefined || parsed <= 0n) return undefined;
  return parsed.toString();
};

const asBoolean = (value: unknown): boolean | undefined => {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
};

const asNumber = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
};

const asRunMode = (value: unknown, fallback: RunMode): RunMode => {
  if (value === "execute" || value === "monitor_only" || value === "dry_run") {
    return value;
  }
  return fallback;
};

const modeToEnum = (mode: RescueModeLabel): number => (mode === "TOP_UP" ? 0 : 1);

const minBigInt = (a: bigint, b: bigint): bigint => (a < b ? a : b);

const toUsdWad = (amount: bigint, decimals: number, priceUsdWad: bigint): bigint => {
  if (amount <= 0n || priceUsdWad <= 0n) return 0n;
  return (amount * priceUsdWad) / (10n ** BigInt(decimals));
};

const wadToFixed = (wad: bigint, fractionDigits = 4): string => {
  const sign = wad < 0n ? "-" : "";
  const abs = wad < 0n ? -wad : wad;
  const whole = abs / WAD;
  if (fractionDigits <= 0) return `${sign}${whole.toString()}`;
  const fracBase = 10n ** BigInt(18 - fractionDigits);
  const frac = (abs % WAD) / fracBase;
  return `${sign}${whole.toString()}.${frac.toString().padStart(fractionDigits, "0")}`;
};

const fromUsdWadToAmount = (usdWad: bigint, decimals: number, priceUsdWad: bigint): bigint => {
  if (usdWad <= 0n || priceUsdWad <= 0n) return 0n;
  return (usdWad * (10n ** BigInt(decimals))) / priceUsdWad;
};

const sortByRiskAscending = (a: FlatPosition, b: FlatPosition): number => {
  if (a.position.healthFactor === b.position.healthFactor) return 0;
  return a.position.healthFactor < b.position.healthFactor ? -1 : 1;
};

const flattenPositions = (snapshots: AdapterSnapshot[]): FlatPosition[] => {
  const flat: FlatPosition[] = [];
  for (const snap of snapshots) {
    for (const position of snap.positions) {
      flat.push({
        label: snap.label,
        adapterAddress: snap.adapterAddress,
        availableCollateral: snap.availableCollateral,
        chainId: snap.chainId,
        chainKey: snap.chainKey,
        isConfiguredAdapter: snap.isConfiguredAdapter,
        rescueTargetChainSelector: snap.rescueTargetChainSelector,
        position,
      });
    }
  }
  return flat;
};

const canonicalAsset = (
  asset: Address,
  crossChainAssetMap: Record<string, string>
): string => {
  const key = asset.toLowerCase();
  const mapped = crossChainAssetMap[key];
  return (mapped ?? key).toLowerCase();
};

const isSameChain = (a: FlatPosition, b: FlatPosition): boolean => {
  if (a.chainId !== undefined && b.chainId !== undefined) {
    return a.chainId === b.chainId;
  }
  if (a.chainKey && b.chainKey) {
    return a.chainKey.toLowerCase() === b.chainKey.toLowerCase();
  }
  return true;
};

const inferRescueModeFromPositions = (
  source: FlatPosition,
  target: FlatPosition,
  crossChainAssetMap: Record<string, string>
): RescueModeLabel | undefined => {
  const srcCollateral = canonicalAsset(
    source.position.collateralAsset as Address,
    crossChainAssetMap
  );
  const srcDebt = canonicalAsset(source.position.debtAsset as Address, crossChainAssetMap);
  const tgtCollateral = canonicalAsset(
    target.position.collateralAsset as Address,
    crossChainAssetMap
  );
  const tgtDebt = canonicalAsset(target.position.debtAsset as Address, crossChainAssetMap);

  if (srcCollateral === tgtCollateral && srcDebt === tgtDebt) {
    return "TOP_UP";
  }
  if (srcCollateral === tgtDebt && srcDebt === tgtCollateral) {
    return "REPAY";
  }
  if (srcCollateral === tgtDebt) {
    return "REPAY";
  }
  if (srcCollateral === tgtCollateral) {
    return "TOP_UP";
  }
  return undefined;
};

const describePlan = (step: RescueStepInput, mode: RescueModeLabel, execId: Hex): string =>
  JSON.stringify({
    execId,
    mode,
    sourceAdapter: step.sourceAdapter,
    targetAdapter: step.targetAdapter,
    collateralAsset: step.collateralAsset,
    debtAsset: step.debtAsset,
    collateralAmount: step.collateralAmount.toString(),
    debtAmount: step.debtAmount.toString(),
    isCrossChain: step.isCrossChain,
    targetChain: step.targetChain.toString(),
  });

const estimateNeededAction = (
  mode: RescueModeLabel,
  target: FlatPosition,
  targetHfBps: number,
  getPriceWad: (asset: Address) => bigint | undefined,
  getDecimals: (asset: Address) => number
): bigint => {
  const collateralPriceWad = getPriceWad(target.position.collateralAsset);
  const debtPriceWad = getPriceWad(target.position.debtAsset);
  const collateralDecimals = getDecimals(target.position.collateralAsset);
  const debtDecimals = getDecimals(target.position.debtAsset);
  const targetHfWad = BigInt(targetHfBps) * 10n ** 14n;

  if (!collateralPriceWad || !debtPriceWad || targetHfWad == 0n) {
    return mode === "TOP_UP"
      ? target.position.collateralAmount / 10n
      : target.position.debtAmount / 5n;
  }

  const collateralUsdWad = toUsdWad(target.position.collateralAmount, collateralDecimals, collateralPriceWad);
  const debtUsdWad = toUsdWad(target.position.debtAmount, debtDecimals, debtPriceWad);
  const effectiveCollateralUsdWad =
    (collateralUsdWad * target.position.liquidationThresholdBps) / BPS_DENOM;

  if (mode === "TOP_UP") {
    const wantedEffectiveCollateralUsdWad = (targetHfWad * debtUsdWad) / WAD;
    if (wantedEffectiveCollateralUsdWad <= effectiveCollateralUsdWad) return 0n;
    const deltaEffectiveUsdWad = wantedEffectiveCollateralUsdWad - effectiveCollateralUsdWad;
    if (target.position.liquidationThresholdBps == 0n) return 0n;
    const deltaCollateralUsdWad = (deltaEffectiveUsdWad * BPS_DENOM) / target.position.liquidationThresholdBps;
    return fromUsdWadToAmount(deltaCollateralUsdWad, collateralDecimals, collateralPriceWad);
  }

  const maxDebtUsdAtTarget = (effectiveCollateralUsdWad * WAD) / targetHfWad;
  if (debtUsdWad <= maxDebtUsdAtTarget) return 0n;
  const debtReductionUsdWad = debtUsdWad - maxDebtUsdAtTarget;
  return fromUsdWadToAmount(debtReductionUsdWad, debtDecimals, debtPriceWad);
};

const statusLabel = (status: bigint): string => {
  if (status === 0n) return "None";
  if (status === 1n) return "InProgress";
  if (status === 2n) return "Completed";
  if (status === 3n) return "Partial";
  if (status === 4n) return "Failed";
  if (status === 5n) return "Cancelled";
  return `Unknown(${status.toString()})`;
};

const normalizeStatus = (value: bigint | number | string): bigint => {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.trunc(value));
  return BigInt(value);
};

const toExecutionId = (
  provided: Hex | undefined,
  strategyId: string,
  user: Address,
  mode: RescueModeLabel,
  trigger: "http" | "cron"
): Hex => {
  if (provided) return provided;
  const minuteBucket = Math.floor(Date.now() / 60000);
  return keccak256(toBytes(`${strategyId}|${user.toLowerCase()}|${mode}|${trigger}|${minuteBucket}`));
};

const buildNoAction = (
  strategyId: ChainlinkApiGuardConfig["strategyId"],
  trigger: "http" | "cron" | "evm_log",
  executionId: string,
  decision: ExecutionEnvelope["decision"],
  reason: string,
  metadata: Record<string, string | number | boolean>,
  settlementState: ExecutionEnvelope["settlementState"] = "NONE"
): ExecutionEnvelope =>
  buildEnvelope({
    executionId,
    strategyId,
    trigger,
    decision,
    reason,
    settlementState,
    metadata,
  });

export const runChainlinkApiGuardFlow = (
  runtime: Runtime<ChainlinkApiGuardConfig>,
  config: ChainlinkApiGuardConfig,
  trigger: "http" | "cron",
  body: Record<string, unknown>
): ExecutionEnvelope => {
  const chain = { chainSelectorName: config.chainSelectorName, isTestnet: config.isTestnet };
  const user = (asAddress(body.user) ?? config.monitoring.defaultUser) as Address;
  const runMode = asRunMode(body.runMode, trigger === "http" ? "execute" : "monitor_only");
  const providedExecutionId = asBytes32(body.executionId);
  const maxFee = asBigInt(body.maxFeeWei) ?? BigInt(config.budget.maxNativeFeeWei);
  const deadlineSec = Number(asBigInt(body.deadlineSeconds) ?? BigInt(config.crossChain.deliveryTimeoutSec));
  const nowSec = Math.floor(Date.now() / 1000);
  const baseExecId = toExecutionId(
    providedExecutionId,
    config.strategyId,
    user,
    config.rescue.defaultMode,
    trigger
  );

  const guard = evaluateChainlinkApiGuard(runtime, config, user);
  if (guard.decision === "ABORT" || guard.decision === "NO_ACTION") {
    return buildNoAction(config.strategyId, trigger, baseExecId, guard.decision, guard.reason, {
      user,
      runMode,
      rescueModePolicy: "AUTO_INFERRED",
      ...guard.metadata,
    });
  }

  let inProgress = false;
  try {
    inProgress = readRescueInProgress(runtime, chain, config.contracts.rescueExecutor as Address, user);
  } catch (error) {
    return buildNoAction(config.strategyId, trigger, baseExecId, "ABORT", "Unable to read rescue lock state", {
      user,
      runMode,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (inProgress) {
    return buildNoAction(config.strategyId, trigger, baseExecId, "ABORT", "Rescue already in progress for user", {
      user,
      runMode,
      rescueModePolicy: "AUTO_INFERRED",
    });
  }

  const pendingExecId = asBytes32(body.pendingExecId);
  if (pendingExecId) {
    let pendingStatus = 0n;
    let pendingMessageId = ZERO_BYTES32 as Hex;
    try {
      pendingStatus = normalizeStatus(
        readRescueStatus(
          runtime,
          chain,
          config.contracts.rescueExecutor as Address,
          pendingExecId
        )
      );
      pendingMessageId = readCcipMessageId(
        runtime,
        chain,
        config.contracts.rescueExecutor as Address,
        pendingExecId
      );
    } catch {}
    if (pendingStatus === 2n && pendingMessageId !== ZERO_BYTES32) {
      return buildNoAction(config.strategyId, trigger, baseExecId, "NO_ACTION", "Pending cross-chain settlement exists", {
        user,
        runMode,
        pendingExecId,
        pendingMessageId,
      }, "DISPATCHED");
    }
  }

  const allFlat = flattenPositions(guard.snapshots);
  const debtBearing = allFlat.filter((p) => p.position.debtAmount > 0n);
  if (debtBearing.length === 0) {
    return buildNoAction(
      config.strategyId,
      trigger,
      baseExecId,
      "ABORT",
      "No debt-bearing positions found for rescue planning",
      {
        user,
        runMode,
        rescueModePolicy: "AUTO_INFERRED",
      }
    );
  }
  debtBearing.sort(sortByRiskAscending);

  const targetAdapterOverride = asAddress(body.targetAdapter);
  const sourceAdapterOverride = asAddress(body.sourceAdapter);
  const forceCrossChain = asBoolean(body.forceCrossChain) ?? false;

  const target =
    debtBearing.find((p) => !targetAdapterOverride || p.adapterAddress === targetAdapterOverride) ??
    debtBearing[0];
  const crossChainAssetMap = config.dataSources.chainlinkApi.crossChainAssetMap ?? {};
  const executionChainKey = config.chainSelectorName.toLowerCase();
  const sourcePool = allFlat.filter(
    (p) =>
      p.adapterAddress !== target.adapterAddress &&
      p.availableCollateral > 0n &&
      p.isConfiguredAdapter &&
      (p.chainKey ? p.chainKey.toLowerCase() === executionChainKey : true)
  );
  const sourceCandidates: SourceCandidate[] = [];
  for (const source of sourcePool) {
    const inferred = inferRescueModeFromPositions(source, target, crossChainAssetMap);
    if (!inferred) continue;
    sourceCandidates.push({ source, mode: inferred });
  }

  if (sourceCandidates.length === 0) {
    return buildNoAction(config.strategyId, trigger, baseExecId, "ABORT", "No compatible rescue source with withdrawable collateral on execution chain", {
      user,
      runMode,
      rescueModePolicy: "AUTO_INFERRED",
      executionChain: config.chainSelectorName,
    });
  }

  const chooseHighestCollateral = (list: SourceCandidate[]): SourceCandidate | undefined => {
    let best: SourceCandidate | undefined;
    for (const item of list) {
      if (sourceAdapterOverride && item.source.adapterAddress !== sourceAdapterOverride) continue;
      if (!best || item.source.availableCollateral > best.source.availableCollateral) best = item;
    }
    return best;
  };

  const selected = chooseHighestCollateral(sourceCandidates);

  if (!selected) {
    return buildNoAction(config.strategyId, trigger, baseExecId, "ABORT", "No eligible source after same-chain-first selection", {
      user,
      runMode,
      rescueModePolicy: "AUTO_INFERRED",
    });
  }

  const source = selected.source;
  let useCrossChain = !isSameChain(source, target);
  if (forceCrossChain) {
    useCrossChain = true;
  }
  if (useCrossChain && !config.rescue.allowCrossChain) {
    return buildNoAction(
      config.strategyId,
      trigger,
      baseExecId,
      "ABORT",
      "Cross-chain rescue required by source/target location but disabled by policy",
      {
        user,
        sourceChainKey: source.chainKey ?? "unknown",
        targetChainKey: target.chainKey ?? "unknown",
      }
    );
  }

  const mode = selected.mode;
  const execId = toExecutionId(providedExecutionId, config.strategyId, user, mode, trigger);

  let existingStatus = 0n;
  try {
    existingStatus = normalizeStatus(
      readRescueStatus(runtime, chain, config.contracts.rescueExecutor as Address, execId)
    );
  } catch (error) {
    return buildNoAction(config.strategyId, trigger, execId, "ABORT", "Unable to read rescue status", {
      user,
      runMode,
      rescueMode: mode,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (existingStatus !== 0n) {
    return buildNoAction(config.strategyId, trigger, execId, "NO_ACTION", "Execution id already used", {
      user,
      runMode,
      rescueMode: mode,
      status: statusLabel(existingStatus),
    });
  }

  const decimalsCache = new Map<string, number>();
  const getDecimals = (asset: Address): number => {
    const key = asset.toLowerCase();
    const cached = decimalsCache.get(key);
    if (cached !== undefined) return cached;
    const fromGuard = guard.decimalsByAsset[key];
    if (typeof fromGuard === "number" && fromGuard > 0) {
      decimalsCache.set(key, fromGuard);
      return fromGuard;
    }
    try {
      const value = readTokenDecimals(runtime, chain, asset);
      decimalsCache.set(key, value);
      return value;
    } catch {
      decimalsCache.set(key, 18);
      return 18;
    }
  };

  const getPriceWad = (asset: Address): bigint | undefined => {
    const raw = guard.priceByAsset[asset.toLowerCase()];
    if (!raw) return undefined;
    try {
      return parseUsdToWad(raw);
    } catch {
      return undefined;
    }
  };

  const destinationChain = useCrossChain
    ? (asBigInt(body.targetChainSelector) ??
      (source.rescueTargetChainSelector ? BigInt(source.rescueTargetChainSelector) : BigInt(config.crossChain.destinationChainSelector)))
    : 0n;
  const targetAdapter = (targetAdapterOverride ?? target.adapterAddress) as Address;
  const sourceAsset = source.position.collateralAsset as Address;
  const defaultTargetAsset =
    mode === "TOP_UP"
      ? ((asAddress(body.targetCollateralAsset) ?? target.position.collateralAsset) as Address)
      : ((asAddress(body.targetDebtAsset) ?? target.position.debtAsset) as Address);

  if (!useCrossChain && sourceAsset.toLowerCase() !== defaultTargetAsset.toLowerCase()) {
    return buildNoAction(config.strategyId, trigger, execId, "ABORT", "No-swap compatibility failed for same-chain rescue", {
      user,
      sourceAsset,
      targetAsset: defaultTargetAsset,
      mode,
    });
  }

  const planningTargetHfBps = Math.max(
    10000,
    Math.trunc(
      asNumber(body.targetHfBps) ??
        config.rescue.targetHfBps ??
        config.thresholds.earlyWarningHfBps
    )
  );
  const desiredAmount =
    asBigInt(body.transferAmount) ??
    estimateNeededAction(mode, target, planningTargetHfBps, getPriceWad, getDecimals);
  const reserveSafeSource = (source.availableCollateral * BigInt(10000 - config.rescue.reserveCapBps)) / BPS_DENOM;
  let sourceHfSafeCap = source.availableCollateral;

  const sourceFloorHfBps = Number(
    asBigInt(body.sourceFloorHfBps) ?? BigInt(config.thresholds.earlyWarningHfBps)
  );
  if (sourceFloorHfBps > 0) {
    const sourcePrice = getPriceWad(source.position.collateralAsset as Address);
    const sourceDebtPrice = getPriceWad(source.position.debtAsset as Address);
    if (sourcePrice && sourceDebtPrice && source.position.debtAmount > 0n) {
      const sourceCollDecimals = getDecimals(source.position.collateralAsset as Address);
      const sourceDebtDecimals = getDecimals(source.position.debtAsset as Address);
      const sourceCollUsdWad = toUsdWad(source.position.collateralAmount, sourceCollDecimals, sourcePrice);
      const sourceDebtUsdWad = toUsdWad(source.position.debtAmount, sourceDebtDecimals, sourceDebtPrice);

      const sourceEffectiveCollUsdWad =
        (sourceCollUsdWad * source.position.liquidationThresholdBps) / BPS_DENOM;
      const floorHfWad = BigInt(sourceFloorHfBps) * 10n ** 14n;
      const minEffectiveCollAtFloorUsdWad = (floorHfWad * sourceDebtUsdWad) / WAD;

      if (
        source.position.liquidationThresholdBps == 0n ||
        sourceEffectiveCollUsdWad <= minEffectiveCollAtFloorUsdWad
      ) {
        sourceHfSafeCap = 0n;
      } else {
        const headroomEffectiveUsdWad = sourceEffectiveCollUsdWad - minEffectiveCollAtFloorUsdWad;
        const headroomCollateralUsdWad =
          (headroomEffectiveUsdWad * BPS_DENOM) / source.position.liquidationThresholdBps;
        sourceHfSafeCap = fromUsdWadToAmount(headroomCollateralUsdWad, sourceCollDecimals, sourcePrice);
      }
    }
  }

  let actionAmount = minBigInt(desiredAmount, minBigInt(reserveSafeSource, sourceHfSafeCap));

  const sourcePrice = getPriceWad(sourceAsset);
  const sourceDecimals = getDecimals(sourceAsset);
  const minActionUsd = Math.max(0, Math.trunc(asNumber(body.minActionUsd) ?? config.rescue.minActionUsd));
  let actionUsdWad = 0n;

  if (sourcePrice) {
    actionUsdWad = toUsdWad(actionAmount, sourceDecimals, sourcePrice);
    const maxNotionalUsdWad = BigInt(Math.max(0, Math.trunc(config.budget.maxRescueNotionalUsd))) * WAD;
    if (actionUsdWad > maxNotionalUsdWad) {
      actionAmount = fromUsdWadToAmount(maxNotionalUsdWad, sourceDecimals, sourcePrice);
      actionUsdWad = toUsdWad(actionAmount, sourceDecimals, sourcePrice);
    }
  }

  if (actionAmount <= 0n) {
    return buildNoAction(config.strategyId, trigger, execId, "ABORT", "Computed rescue amount is zero after constraints", {
      user,
      mode,
      desiredAmount: desiredAmount.toString(),
      reserveSafeSource: reserveSafeSource.toString(),
      sourceHfSafeCap: sourceHfSafeCap.toString(),
      sourceFloorHfBps,
      targetHfBps: planningTargetHfBps,
      ...guard.metadata,
    });
  }

  if (sourcePrice && minActionUsd > 0) {
    const minActionUsdWad = BigInt(minActionUsd) * WAD;
    if (actionUsdWad < minActionUsdWad) {
      return buildNoAction(
        config.strategyId,
        trigger,
        execId,
        "NO_ACTION",
        "Computed rescue amount below minimum action threshold",
        {
          user,
          runMode,
          mode,
          actionAmount: actionAmount.toString(),
          actionUsd: wadToFixed(actionUsdWad, 6),
          minActionUsd,
          targetHfBps: planningTargetHfBps,
          ...guard.metadata,
        }
      );
    }
  }

  const step: RescueStepInput = {
    stepIndex: 0n,
    sourceAdapter: source.adapterAddress as Address,
    targetAdapter,
    collateralAsset: sourceAsset,
    debtAsset: mode === "REPAY" ? defaultTargetAsset : target.position.debtAsset,
    collateralAmount: actionAmount,
    debtAmount: mode === "REPAY" ? actionAmount : 0n,
    isCrossChain: useCrossChain,
    targetChain: destinationChain,
  };

  if (useCrossChain && destinationChain === 0n) {
    return buildNoAction(config.strategyId, trigger, execId, "ABORT", "Cross-chain selected but target chain selector is missing", {
      user,
      mode,
    });
  }

  runtime.log(`Planning rescue with step: ${describePlan(step, mode, execId)}`);

  const plan: RescuePlanInput = {
    execId,
    user,
    mode: modeToEnum(mode),
    steps: [step],
    deadline: BigInt(nowSec + 1000000000), // effectively no deadline - actual execution will check against block.timestamp and revert if past deadline
    maxFee,
  };

  if (runMode !== "execute") {
    return buildEnvelope({
      executionId: execId,
      strategyId: config.strategyId,
      trigger,
      decision: useCrossChain ? "RESCUE_CROSS_CHAIN" : "RESCUE_SAME_CHAIN",
      reason: "Rescue plan created (execution skipped by runMode)",
      settlementState: "NONE",
      metadata: {
        user,
        runMode,
        rescueMode: mode,
        plannedCrossChain: useCrossChain,
        targetHfBps: planningTargetHfBps,
        planPreview: describePlan(step, mode, execId),
      },
    });
  }

  let txHash: Hex;
  const reportReceiver =
    asAddress(body.workflowReceiver) ??
    (asAddress(config.contracts.workflowReceiver) ?? asAddress(config.contracts.rescueReporter));

  if (!reportReceiver) {
    return buildNoAction(config.strategyId, trigger, execId, "ABORT", "Workflow receiver is not configured", {
      user,
      runMode,
      rescueMode: mode,
    });
  }

  const reportGasLimit =
    asGasLimit(body.reportGasLimit) ??
    (useCrossChain ? "3500000" : "2500000");

  try {
    txHash = submitRescuePlanReport(
      runtime,
      chain,
      reportReceiver,
      plan,
      reportGasLimit
    );
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    const manualFallback =
      errMsg.includes("writeReport") && errMsg.includes("unavailable");
    if (manualFallback) {
      return buildNoAction(
        config.strategyId,
        trigger,
        execId,
        "ABORT",
        "CRE runtime cannot submit signed reports in current SDK; execute rescue via Forge script",
        {
          user,
          runMode,
          rescueMode: mode,
          plannedCrossChain: useCrossChain,
          planPreview: describePlan(step, mode, execId),
          recommendedScript: "contracts/script/reprieve/ExecuteSameChainRescueFromPlan.s.sol",
          error: errMsg,
        }
      );
    }
    return buildNoAction(config.strategyId, trigger, execId, "ABORT", "executeRescue reverted", {
      user,
      runMode,
      rescueMode: mode,
      error: errMsg,
    });
  }

  let messageId = ZERO_BYTES32 as Hex;
  let finalStatus = 0n;
  try {
    messageId = readCcipMessageId(
      runtime,
      chain,
      config.contracts.rescueExecutor as Address,
      execId
    );
  } catch {}
  try {
    finalStatus = normalizeStatus(
      readRescueStatus(runtime, chain, config.contracts.rescueExecutor as Address, execId)
    );
  } catch {}

  const settlementState: ExecutionEnvelope["settlementState"] =
    useCrossChain && messageId !== ZERO_BYTES32
      ? "DISPATCHED"
      : finalStatus === 2n || finalStatus === 3n
      ? "DELIVERED_SUCCESS"
      : "NONE";

  return buildEnvelope({
    executionId: execId,
    strategyId: config.strategyId,
    trigger,
    decision: useCrossChain ? "RESCUE_CROSS_CHAIN" : "RESCUE_SAME_CHAIN",
    reason: "Rescue report submitted",
    settlementState,
    txRefs: [
      {
        chainSelectorName: config.chainSelectorName,
        txHash,
        label: "writeReport(onReport)",
      },
    ],
    metadata: {
      user,
      runMode,
      reportReceiver,
      rescueMode: mode,
      sourceAdapter: step.sourceAdapter,
      targetAdapter: step.targetAdapter,
      sourceAsset: step.collateralAsset,
      targetAsset: defaultTargetAsset,
      amount: actionAmount.toString(),
      targetHfBps: planningTargetHfBps,
      sourceFloorHfBps,
      sourceHfSafeCap: sourceHfSafeCap.toString(),
      crossChain: useCrossChain,
      targetChain: destinationChain.toString(),
      ccipMessageId: messageId,
      sourceRescueStatus: statusLabel(finalStatus),
      preSimSkipped: true,
    },
  });
};

export const reconcileChainlinkApiGuardLog = (
  runtime: Runtime<ChainlinkApiGuardConfig>,
  config: ChainlinkApiGuardConfig,
  payload: EVMLog
): ExecutionEnvelope => {
  const terminal = decodeCrossChainTerminalEvent(payload);
  if (terminal) {
    if (terminal.status === "SUCCESS") {
      return buildEnvelope({
        executionId: terminal.execId,
        strategyId: config.strategyId,
        trigger: "evm_log",
        decision: "NO_ACTION",
        reason: "Cross-chain leg completed on destination",
        settlementState: "DELIVERED_SUCCESS",
        metadata: {
          messageId: terminal.messageId,
          amountReceived: terminal.amountReceived?.toString() ?? "0",
        },
      });
    }

    let escrowId = ZERO_BYTES32;
    try {
      const failed = readFailedMessage(
        runtime,
        { chainSelectorName: config.chainSelectorName, isTestnet: config.isTestnet },
        config.contracts.ccipReceiver as Address,
        terminal.messageId
      );
      escrowId = failed.escrowId;
    } catch {}

    return buildEnvelope({
      executionId: terminal.execId,
      strategyId: config.strategyId,
      trigger: "evm_log",
      decision: "ABORT",
      reason: terminal.reason ?? "Cross-chain destination failure",
      settlementState: "DELIVERED_FAILED",
      metadata: {
        messageId: terminal.messageId,
        escrowId,
      },
    });
  }

  const decoded = decodeReprieveEvent(payload);
  if (!decoded) {
    return buildNoAction(
      config.strategyId,
      "evm_log",
      `evm-log-${Date.now()}`,
      "NO_ACTION",
      "Ignored non-Reprieve event",
      {}
    );
  }

  if (decoded.eventName === "CrossChainInitiated") {
    return buildNoAction(
      config.strategyId,
      "evm_log",
      String(decoded.args.execId ?? `evm-log-${Date.now()}`),
      "NO_ACTION",
      "Cross-chain dispatch initiated",
      {
        messageId: String(decoded.args.ccipMessageId ?? ZERO_BYTES32),
      },
      "DISPATCHED"
    );
  }

  if (decoded.eventName === "RescueCompleted") {
    return buildNoAction(
      config.strategyId,
      "evm_log",
      String(decoded.args.execId ?? `evm-log-${Date.now()}`),
      "NO_ACTION",
      "Rescue completed",
      {},
      "DELIVERED_SUCCESS"
    );
  }

  if (decoded.eventName === "RescueFailed") {
    return buildNoAction(
      config.strategyId,
      "evm_log",
      String(decoded.args.execId ?? `evm-log-${Date.now()}`),
      "ABORT",
      "Rescue failed",
      {},
      "DELIVERED_FAILED"
    );
  }

  return buildNoAction(
    config.strategyId,
    "evm_log",
    String(decoded.args.execId ?? `evm-log-${Date.now()}`),
    "NO_ACTION",
    `Observed ${decoded.eventName}`,
    {}
  );
};

export const __testables = {
  inferRescueModeFromPositions,
  isSameChain,
};
