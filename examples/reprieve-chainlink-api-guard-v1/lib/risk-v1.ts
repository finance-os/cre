import {
  HTTPClient,
  consensusIdenticalAggregation,
  json,
  ok,
  type NodeRuntime,
  type Runtime,
} from "@chainlink/cre-sdk";
import { keccak256, toBytes, type Address } from "viem";
import type {
  ChainlinkApiGuardConfig,
  MonitoredAdapterConfig,
  RescueDecision,
} from "../types";
import {
  discoverPositions,
  readMockOraclePrice,
  readTokenDecimals,
  type AdapterPosition,
} from "./contracts";

const WAD = 10n ** 18n;
const BPS_DENOM = 10000n;
const MAX_PENALTY_BPS = 9000n;
const MAX_HF_WAD = (2n ** 255n) - 1n;

type PriceReport = {
  asset: Address;
  priceUsd: string;
  updatedAt: number;
  prevPriceUsd?: string;
  integrityHash?: string;
  source: "api" | "oracle" | "mock";
};

export type ChainlinkV1Evaluation = {
  decision: RescueDecision;
  reason: string;
  metadata: Record<string, string | number | boolean>;
  snapshots: AdapterSnapshot[];
  priceByAsset: Record<string, string>;
  decimalsByAsset: Record<string, number>;
};

export type AdapterSnapshot = {
  label: string;
  adapterAddress: Address;
  positions: AdapterPosition[];
  hfWad: bigint;
  availableCollateral: bigint;
  chainId?: number;
  chainKey?: string;
  isConfiguredAdapter: boolean;
  rescueTargetChainSelector?: string;
};

type ApiResponseShape = {
  timestamp?: number;
  reports?: Array<{
    asset?: string;
    token?: string;
    priceUsd?: string | number;
    price?: string | number;
    updatedAt?: number;
    timestamp?: number;
    prevPriceUsd?: string | number;
    prevPrice?: string | number;
    integrityHash?: string;
  }>;
  prices?: Record<string, string | number>;
};

type BackendRiskSnapshotResponse = {
  user?: string;
  latestSyncedAt?: string | null;
  latestAgeSec?: number;
  maxAgeSec?: number;
  isStale?: boolean;
  positions?: BackendRiskSnapshotPosition[];
};

type BackendRiskSnapshotPosition = {
  chainId?: number;
  chainKey?: string;
  protocol?: string;
  adapterAddress?: string;
  collateralAsset?: string;
  debtAsset?: string;
  collateralAmountRaw?: string;
  debtAmountRaw?: string;
  healthFactorWad?: string;
  ltvBps?: number | null;
  maxLtvBps?: number | null;
  liquidationThresholdBps?: number | null;
  collateralDecimals?: number;
  debtDecimals?: number;
};

type BackendRiskSnapshotWire = {
  user?: string;
  latestSyncedAt?: string;
  latestAgeSec?: number;
  maxAgeSec?: number;
  isStale?: boolean;
  positions?: BackendRiskSnapshotPositionWire[];
};

type BackendRiskSnapshotPositionWire = {
  chainId?: number;
  chainKey?: string;
  protocol?: string;
  adapterAddress?: string;
  collateralAsset?: string;
  debtAsset?: string;
  collateralAmountRaw?: string;
  debtAmountRaw?: string;
  healthFactorWad?: string;
  ltvBps?: number;
  maxLtvBps?: number;
  liquidationThresholdBps?: number;
  collateralDecimals?: number;
  debtDecimals?: number;
};

export const parseUsdToWad = (value: string): bigint => {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid USD value: ${value}`);
  }
  const [whole, frac = ""] = trimmed.split(".");
  const fracPadded = `${frac}000000000000000000`.slice(0, 18);
  return BigInt(whole) * WAD + BigInt(fracPadded);
};

const formatUnits = (value: bigint, decimals: number, fractionDigits = 4): string => {
  const sign = value < 0n ? "-" : "";
  const abs = value < 0n ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const fractionRaw = abs % base;

  if (fractionDigits <= 0) {
    return `${sign}${whole.toString()}`;
  }

  const padded = fractionRaw.toString().padStart(decimals, "0");
  const sliced = padded.slice(0, Math.min(fractionDigits, decimals));
  const trimmed = sliced.replace(/0+$/, "");
  if (trimmed.length === 0) {
    return `${sign}${whole.toString()}`;
  }
  return `${sign}${whole.toString()}.${trimmed}`;
};

const formatHf = (hfWad: bigint): string => {
  if (hfWad >= MAX_HF_WAD / 2n) {
    return "INF";
  }
  return formatUnits(hfWad, 18, 4);
};

const bpsToWad = (bps: number): bigint => BigInt(bps) * (10n ** 14n);

const buildIntegrityHash = (
  asset: string,
  priceUsd: string,
  updatedAt: number,
  integritySalt: string
): string => keccak256(toBytes(`${asset.toLowerCase()}|${priceUsd}|${updatedAt}|${integritySalt}`));

const verifyReportIntegrity = (
  report: PriceReport,
  integritySalt: string
): boolean => {
  if (!report.integrityHash) return false;
  const expected = buildIntegrityHash(
    report.asset,
    report.priceUsd,
    report.updatedAt,
    integritySalt
  );
  return expected.toLowerCase() === report.integrityHash.toLowerCase();
};

const normalizeApiReports = (
  raw: unknown,
  fallbackTimestamp: number
): PriceReport[] => {
  const payload = (raw ?? {}) as ApiResponseShape;
  const reportTs = typeof payload.timestamp === "number" ? payload.timestamp : fallbackTimestamp;

  if (Array.isArray(payload.reports)) {
    return payload.reports
      .filter((item) => item && (item.asset || item.token))
      .map((item) => {
        const asset = ((item.asset ?? item.token) || "").toLowerCase() as Address;
        const price = String(item.priceUsd ?? item.price ?? "0");
        const updatedAt = Number(item.updatedAt ?? item.timestamp ?? reportTs);
        const prevPrice = item.prevPriceUsd ?? item.prevPrice;
        return {
          asset,
          priceUsd: price,
          updatedAt,
          prevPriceUsd: prevPrice === undefined ? undefined : String(prevPrice),
          integrityHash: item.integrityHash,
          source: "api" as const,
        };
      });
  }

  if (payload.prices && typeof payload.prices === "object") {
    return Object.entries(payload.prices).map(([asset, price]) => ({
      asset: asset.toLowerCase() as Address,
      priceUsd: String(price),
      updatedAt: reportTs,
      source: "api" as const,
    }));
  }

  return [];
};

const ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;

const toOptionalAddress = (value: unknown): Address | undefined => {
  if (typeof value !== "string" || !ADDRESS_REGEX.test(value)) {
    return undefined;
  }
  return value.toLowerCase() as Address;
};

const toOptionalBigInt = (value: unknown): bigint | undefined => {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    return BigInt(Math.trunc(value));
  }
  if (typeof value === "string" && /^[0-9]+$/.test(value)) {
    return BigInt(value);
  }
  return undefined;
};

const toBpsBigInt = (value: number | null | undefined, fallback: number): bigint => {
  const raw = value ?? fallback;
  return BigInt(Math.max(0, Math.trunc(raw)));
};

const toPositiveInt = (value: unknown, fallback: number): number => {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.trunc(parsed);
    }
  }
  return fallback;
};

const resolvePositionsSnapshotUrl = (
  baseUrl: string,
  path: string,
  user: Address,
  maxAgeSec?: number
): string => {
  let resolvedPath = path;
  if (resolvedPath.includes(":address")) {
    resolvedPath = resolvedPath.replace(":address", user);
  } else if (resolvedPath.includes("{address}")) {
    resolvedPath = resolvedPath.replace("{address}", user);
  }

  const absolute =
    resolvedPath.startsWith("http://") || resolvedPath.startsWith("https://");
  let url = absolute
    ? resolvedPath
    : `${baseUrl.replace(/\/+$/, "")}/${resolvedPath.replace(/^\/+/, "")}`;

  if (maxAgeSec && maxAgeSec > 0) {
    const hasQuery = url.includes("?");
    url = `${url}${hasQuery ? "&" : "?"}maxAgeSec=${maxAgeSec}`;
  }
  return url;
};

const loadBackendRiskSnapshot = (
  runtime: Runtime<ChainlinkApiGuardConfig>,
  config: ChainlinkApiGuardConfig,
  user: Address
): BackendRiskSnapshotResponse => {
  const source = config.dataSources.chainlinkApi;
  if (!source.positionsApiBaseUrl || !source.positionsApiPath) {
    throw new Error("Backend positions API is not configured");
  }

  const url = resolvePositionsSnapshotUrl(
    source.positionsApiBaseUrl,
    source.positionsApiPath,
    user,
    source.positionsApiMaxAgeSec
  );

  const wire = runtime.runInNodeMode(
    (nodeRuntime: NodeRuntime<ChainlinkApiGuardConfig>) => {
      const client = new HTTPClient();
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (source.positionsApiKey && source.positionsApiKey.trim().length > 0) {
        headers["x-api-key"] = source.positionsApiKey;
      }

      const response = client
        .sendRequest(nodeRuntime, {
          url,
          method: "GET",
          headers,
        })
        .result();

      if (!ok(response)) {
        throw new Error(`Backend positions API failed with status ${response.statusCode}`);
      }

      const payload = json(response) as BackendRiskSnapshotResponse;
      return {
        user: typeof payload.user === "string" ? payload.user : undefined,
        latestSyncedAt:
          typeof payload.latestSyncedAt === "string" ? payload.latestSyncedAt : undefined,
        latestAgeSec:
          typeof payload.latestAgeSec === "number" ? payload.latestAgeSec : undefined,
        maxAgeSec: typeof payload.maxAgeSec === "number" ? payload.maxAgeSec : undefined,
        isStale: payload.isStale === true,
        positions: Array.isArray(payload.positions)
          ? payload.positions.map((position) => ({
              chainId: typeof position.chainId === "number" ? position.chainId : undefined,
              chainKey: typeof position.chainKey === "string" ? position.chainKey : undefined,
              protocol: typeof position.protocol === "string" ? position.protocol : undefined,
              adapterAddress:
                typeof position.adapterAddress === "string"
                  ? position.adapterAddress
                  : undefined,
              collateralAsset:
                typeof position.collateralAsset === "string"
                  ? position.collateralAsset
                  : undefined,
              debtAsset:
                typeof position.debtAsset === "string" ? position.debtAsset : undefined,
              collateralAmountRaw:
                typeof position.collateralAmountRaw === "string"
                  ? position.collateralAmountRaw
                  : undefined,
              debtAmountRaw:
                typeof position.debtAmountRaw === "string"
                  ? position.debtAmountRaw
                  : undefined,
              healthFactorWad:
                typeof position.healthFactorWad === "string"
                  ? position.healthFactorWad
                  : undefined,
              ltvBps: typeof position.ltvBps === "number" ? position.ltvBps : undefined,
              maxLtvBps:
                typeof position.maxLtvBps === "number" ? position.maxLtvBps : undefined,
              liquidationThresholdBps:
                typeof position.liquidationThresholdBps === "number"
                  ? position.liquidationThresholdBps
                  : undefined,
              collateralDecimals:
                typeof position.collateralDecimals === "number"
                  ? position.collateralDecimals
                  : undefined,
              debtDecimals:
                typeof position.debtDecimals === "number" ? position.debtDecimals : undefined,
            }))
          : [],
      } satisfies BackendRiskSnapshotWire;
    },
    consensusIdenticalAggregation<BackendRiskSnapshotWire>()
  )().result();

  const payload: BackendRiskSnapshotResponse = {
    user: wire.user,
    latestSyncedAt: wire.latestSyncedAt,
    latestAgeSec: wire.latestAgeSec,
    maxAgeSec: wire.maxAgeSec,
    isStale: wire.isStale,
    positions: wire.positions?.map((position) => ({
      chainId: position.chainId,
      chainKey: position.chainKey,
      protocol: position.protocol,
      adapterAddress: position.adapterAddress,
      collateralAsset: position.collateralAsset,
      debtAsset: position.debtAsset,
      collateralAmountRaw: position.collateralAmountRaw,
      debtAmountRaw: position.debtAmountRaw,
      healthFactorWad: position.healthFactorWad,
      ltvBps: position.ltvBps,
      maxLtvBps: position.maxLtvBps,
      liquidationThresholdBps: position.liquidationThresholdBps,
      collateralDecimals: position.collateralDecimals,
      debtDecimals: position.debtDecimals,
    })),
  };
  if (!Array.isArray(payload.positions)) {
    throw new Error("Backend positions API returned invalid payload");
  }

  return payload;
};

const buildSnapshotsFromBackend = (
  runtime: Runtime<ChainlinkApiGuardConfig>,
  config: ChainlinkApiGuardConfig,
  snapshot: BackendRiskSnapshotResponse
): {
  snapshots: AdapterSnapshot[];
  decimalsByAsset: Record<string, number>;
  latestAgeSec: number;
  isStale: boolean;
} => {
  const adapterConfigByAddress = new Map<string, MonitoredAdapterConfig>();
  for (const adapter of config.monitoring.adapters) {
    adapterConfigByAddress.set(adapter.adapterAddress.toLowerCase(), adapter);
  }

  const grouped = new Map<
    string,
    {
      label: string;
      adapterAddress: Address;
      positions: AdapterPosition[];
      availableCollateral: bigint;
      hfWad: bigint;
      chainId?: number;
      chainKey?: string;
      isConfiguredAdapter: boolean;
      rescueTargetChainSelector?: string;
      debtBearingSeen: boolean;
    }
  >();
  const decimalsByAsset: Record<string, number> = {};

  for (const rawPosition of snapshot.positions ?? []) {
    const adapterAddress = toOptionalAddress(rawPosition.adapterAddress);
    const collateralAsset = toOptionalAddress(rawPosition.collateralAsset);
    const debtAsset = toOptionalAddress(rawPosition.debtAsset);
    const collateralAmount = toOptionalBigInt(rawPosition.collateralAmountRaw);
    const debtAmount = toOptionalBigInt(rawPosition.debtAmountRaw);
    const healthFactor = toOptionalBigInt(rawPosition.healthFactorWad);

    if (!adapterAddress || !collateralAsset || !debtAsset) {
      continue;
    }
    if (collateralAmount === undefined || debtAmount === undefined) {
      continue;
    }

    const chainId = Number(rawPosition.chainId ?? 0);
    const chainKey = typeof rawPosition.chainKey === "string" ? rawPosition.chainKey : "unknown";
    const groupKey = `${chainId}:${adapterAddress.toLowerCase()}`;
    const adapterConfig = adapterConfigByAddress.get(adapterAddress.toLowerCase());
    const labelBase =
      adapterConfig?.label ??
      `${(rawPosition.protocol ?? "adapter").toString().toLowerCase()}-${chainKey}`;
    const label = `${labelBase}@${chainKey}`;

    const position: AdapterPosition = {
      protocol: "0x0000000000000000000000000000000000000000",
      collateralAsset,
      debtAsset,
      collateralAmount,
      debtAmount,
      healthFactor: healthFactor ?? MAX_HF_WAD,
      ltvBps: toBpsBigInt(rawPosition.ltvBps, 7500),
      maxLtvBps: toBpsBigInt(rawPosition.maxLtvBps, 7500),
      liquidationThresholdBps: toBpsBigInt(rawPosition.liquidationThresholdBps, 8000),
    };

    const existing = grouped.get(groupKey);
    if (!existing) {
      grouped.set(groupKey, {
        label,
        adapterAddress,
        positions: [position],
        availableCollateral: collateralAmount,
        hfWad: debtAmount > 0n ? position.healthFactor : MAX_HF_WAD,
        chainId,
        chainKey,
        isConfiguredAdapter: !!adapterConfig,
        rescueTargetChainSelector: adapterConfig?.rescueTargetChainSelector,
        debtBearingSeen: debtAmount > 0n,
      });
    } else {
      existing.positions.push(position);
      existing.availableCollateral += collateralAmount;
      if (debtAmount > 0n) {
        existing.debtBearingSeen = true;
        if (position.healthFactor < existing.hfWad) {
          existing.hfWad = position.healthFactor;
        }
      }
    }

    const collateralDecimals = toPositiveInt(rawPosition.collateralDecimals, 18);
    const debtDecimals = toPositiveInt(rawPosition.debtDecimals, 18);
    decimalsByAsset[collateralAsset.toLowerCase()] = collateralDecimals;
    decimalsByAsset[debtAsset.toLowerCase()] = debtDecimals;
  }

  const snapshots = Array.from(grouped.values()).map((group) => ({
    label: group.label,
    adapterAddress: group.adapterAddress,
    positions: group.positions,
    hfWad: group.debtBearingSeen ? group.hfWad : MAX_HF_WAD,
    availableCollateral: group.availableCollateral,
    chainId: group.chainId,
    chainKey: group.chainKey,
    isConfiguredAdapter: group.isConfiguredAdapter,
    rescueTargetChainSelector: group.rescueTargetChainSelector,
  }));

  const latestAgeSec = toPositiveInt(snapshot.latestAgeSec, Number.MAX_SAFE_INTEGER);
  const configuredMaxAge = toPositiveInt(
    config.dataSources.chainlinkApi.positionsApiMaxAgeSec,
    toPositiveInt(snapshot.maxAgeSec, 600)
  );
  const staleByFlag = snapshot.isStale === true;
  const staleByAge = latestAgeSec > configuredMaxAge;

  runtime.log(
    `[V1] Backend positions loaded: count=${snapshots.length} latestAgeSec=${latestAgeSec} maxAgeSec=${configuredMaxAge} stale=${staleByFlag || staleByAge}`
  );

  return {
    snapshots,
    decimalsByAsset,
    latestAgeSec,
    isStale: staleByFlag || staleByAge,
  };
};

const loadApiReports = (
  runtime: Runtime<ChainlinkApiGuardConfig>,
  config: ChainlinkApiGuardConfig,
  assets: Address[]
): PriceReport[] => {
  const query = encodeURIComponent(assets.join(","));
  const url = `${config.dataSources.chainlinkApi.priceApiBaseUrl}${config.dataSources.chainlinkApi.priceApiPath}?assets=${query}`;

  const raw = runtime.runInNodeMode(
    (nodeRuntime: NodeRuntime<ChainlinkApiGuardConfig>) => {
      const client = new HTTPClient();
      const response = client
        .sendRequest(nodeRuntime, {
          url,
          method: "GET",
          headers: {
            "content-type": "application/json",
          },
        })
        .result();

      if (!ok(response)) {
        throw new Error(`Price API failed with status ${response.statusCode}`);
      }

      return json(response) as ApiResponseShape;
    },
    consensusIdenticalAggregation<ApiResponseShape>()
  )().result();

  return normalizeApiReports(raw, Math.floor(Date.now() / 1000));
};

const loadReportsWithFallback = (
  runtime: Runtime<ChainlinkApiGuardConfig>,
  config: ChainlinkApiGuardConfig,
  chain: { chainSelectorName: string; isTestnet: boolean },
  assets: Address[]
): PriceReport[] => {
  const onchainOracle = config.dataSources.chainlinkApi.mockOracleAddress as Address | undefined;
  const preferOnchainOracle = config.dataSources.chainlinkApi.preferOnchainOracle ?? false;

  const loadOnchainOracleReports = (): PriceReport[] => {
    if (!onchainOracle) return [];
    const reports: PriceReport[] = [];
    for (const asset of assets) {
      try {
        const { priceWad, updatedAt } = readMockOraclePrice(runtime, chain, onchainOracle, asset);

        runtime.log(`On-chain oracle read for ${asset}: price=${formatUnits(priceWad, 18)} updatedAt=${updatedAt}`
        );
        if (priceWad <= 0n || updatedAt <= 0) {
          continue;
        }
        reports.push({
          asset: asset.toLowerCase() as Address,
          priceUsd: formatUnits(priceWad, 18, 8),
          updatedAt,
          source: "oracle",
        });
      } catch (error) {
        runtime.log(
          `On-chain oracle read failed for ${asset}: ${error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
    return reports;
  };

  const loadApiReportsSafe = (): PriceReport[] => {
    try {
      return loadApiReports(runtime, config, assets);
    } catch (error) {
      runtime.log(`Price API fetch failed: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  };

  const reportMap = new Map<Address, PriceReport>();
  const seedReports = (reports: PriceReport[]) => {
    for (const report of reports) {
      const key = report.asset.toLowerCase() as Address;
      if (!reportMap.has(key)) {
        reportMap.set(key, report);
      }
    }
  };

  if (preferOnchainOracle) {
    seedReports(loadOnchainOracleReports());
    if (reportMap.size < assets.length) {
      seedReports(loadApiReportsSafe());
    }
  } else {
    seedReports(loadApiReportsSafe());
    if (reportMap.size < assets.length) {
      seedReports(loadOnchainOracleReports());
    }
  }

  const nowTs = Math.floor(Date.now() / 1000);
  for (const asset of assets) {
    const key = asset.toLowerCase() as Address;
    if (reportMap.has(key)) continue;
    const priceUsd = config.dataSources.chainlinkApi.mockPricesUsd[asset.toLowerCase()];
    if (priceUsd) {
      reportMap.set(key, {
        asset: key,
        priceUsd,
        updatedAt: nowTs,
        source: "mock",
        integrityHash: buildIntegrityHash(
          asset,
          priceUsd,
          nowTs,
          config.dataSources.chainlinkApi.integritySalt
        ),
      });
    }
  }

  return Array.from(reportMap.values());
};

const computeShockBps = (report: PriceReport): number => {
  if (!report.prevPriceUsd) return 0;
  const nowWad = parseUsdToWad(report.priceUsd);
  const prevWad = parseUsdToWad(report.prevPriceUsd);
  if (prevWad === 0n) return 0;

  const diff = nowWad > prevWad ? nowWad - prevWad : prevWad - nowWad;
  return Number((diff * BPS_DENOM) / prevWad);
};

const canonicalizeAsset = (
  asset: Address,
  crossChainAssetMap: Record<string, string>
): Address => {
  const mapped = crossChainAssetMap[asset.toLowerCase()];
  if (!mapped || !ADDRESS_REGEX.test(mapped)) {
    return asset.toLowerCase() as Address;
  }
  return mapped.toLowerCase() as Address;
};

const inferChainIdFromSelectorName = (selectorName?: string): number | undefined => {
  if (!selectorName) return undefined;
  const key = selectorName.toLowerCase();
  if (key === "ethereum-testnet-sepolia") return 11155111;
  if (key === "base-testnet-sepolia" || key === "ethereum-testnet-sepolia-base-1") return 84532;
  return undefined;
};

const evaluateDecision = (
  weakestEffectiveHfWad: bigint,
  config: ChainlinkApiGuardConfig,
  snapshots: AdapterSnapshot[],
  weakestPositionChainId?: number,
  weakestPositionChainKey?: string
): RescueDecision => {
  const minHfWad = bpsToWad(config.thresholds.onchainHfMinBps);
  const earlyHfWad = bpsToWad(config.thresholds.earlyWarningHfBps);
  const canCrossChain = snapshots.some((snap) => {
    if (!snap.isConfiguredAdapter || snap.availableCollateral <= 0n) {
      return false;
    }
    if (
      weakestPositionChainId !== undefined &&
      snap.chainId !== undefined
    ) {
      return snap.chainId !== weakestPositionChainId;
    }
    if (weakestPositionChainKey && snap.chainKey) {
      return snap.chainKey.toLowerCase() !== weakestPositionChainKey.toLowerCase();
    }
    return false;
  });

  return decideRoute(
    weakestEffectiveHfWad,
    minHfWad,
    earlyHfWad,
    config.rescue.allowCrossChain,
    canCrossChain
  );
};

const decideRoute = (
  weakestEffectiveHfWad: bigint,
  minHfWad: bigint,
  earlyHfWad: bigint,
  allowCrossChain: boolean,
  canCrossChain: boolean
): RescueDecision => {
  if (weakestEffectiveHfWad <= minHfWad || weakestEffectiveHfWad <= earlyHfWad) {
    if (allowCrossChain && canCrossChain) {
      return "RESCUE_CROSS_CHAIN";
    }
    return "RESCUE_SAME_CHAIN";
  }

  return "NO_ACTION";
};

export const evaluateChainlinkApiGuard = (
  runtime: Runtime<ChainlinkApiGuardConfig>,
  config: ChainlinkApiGuardConfig,
  user: Address
): ChainlinkV1Evaluation => {
  const stalePolicy = config.dataSources.chainlinkApi.stalePolicy ?? "ABORT";
  const priceReadChain = {
    chainSelectorName: config.chainSelectorName,
    isTestnet: config.isTestnet,
  };

  let snapshots: AdapterSnapshot[] = [];
  let decimalsByAsset: Record<string, number> = {};
  const positionSource: "onchain" = "onchain";
  const adapterReadErrors: string[] = [];
  const decimalsCache = new Map<Address, number>();

  for (const adapterCfg of config.monitoring.adapters) {
    const adapterAddress = adapterCfg.adapterAddress as Address;
    const adapterChain = {
      chainSelectorName: adapterCfg.chainSelectorName ?? config.chainSelectorName,
      isTestnet: adapterCfg.isTestnet ?? config.isTestnet,
    };
    runtime.log(
      `[V1][adapter-read] label=${adapterCfg.label} chain=${adapterChain.chainSelectorName} adapter=${adapterAddress}`
    );

    let positions: AdapterPosition[] = [];
    let hfWad = MAX_HF_WAD;
    let availableCollateral = 0n;

    try {
      positions = discoverPositions(runtime, adapterChain, adapterAddress, user);
      runtime.log(
        `[V1][adapter-read] label=${adapterCfg.label} chain=${adapterChain.chainSelectorName} positions=${positions.length}`
      );
      if (positions.length === 0) continue;

      for (const position of positions) {
        availableCollateral += position.collateralAmount;
        if (position.debtAmount > 0n && position.healthFactor < hfWad) {
          hfWad = position.healthFactor;
        }

        const collateralAsset = (position.collateralAsset as Address).toLowerCase() as Address;
        const debtAsset = (position.debtAsset as Address).toLowerCase() as Address;

        if (!decimalsCache.has(collateralAsset)) {
          try {
            const value = readTokenDecimals(runtime, adapterChain, collateralAsset);
            decimalsCache.set(collateralAsset, value);
            decimalsByAsset[collateralAsset] = value;
          } catch {}
        }

        if (!decimalsCache.has(debtAsset)) {
          try {
            const value = readTokenDecimals(runtime, adapterChain, debtAsset);
            decimalsCache.set(debtAsset, value);
            decimalsByAsset[debtAsset] = value;
          } catch {}
        }
      }
    } catch (error) {
      runtime.log(
        `[V1][adapter-read] label=${adapterCfg.label} chain=${adapterChain.chainSelectorName} status=error reason=${error instanceof Error ? error.message : String(error)}`
      );
      adapterReadErrors.push(
        `${adapterCfg.label}@${adapterChain.chainSelectorName}:${error instanceof Error ? error.message : String(error)}`
      );
      continue;
    }

    snapshots.push({
      label: adapterCfg.label,
      adapterAddress,
      positions,
      hfWad,
      availableCollateral,
      chainId: inferChainIdFromSelectorName(adapterChain.chainSelectorName),
      chainKey: adapterChain.chainSelectorName,
      isConfiguredAdapter: true,
      rescueTargetChainSelector: adapterCfg.rescueTargetChainSelector,
    });
  }

  if (snapshots.length === 0) {
    runtime.log("[V1] No positions discovered for monitored adapters.");
    return {
      decision: "ABORT",
      reason: "No positions found for monitored adapters",
      metadata: {
        user,
        positionSource,
        adapterReadErrors: adapterReadErrors.length,
      },
      snapshots: [],
      priceByAsset: {},
      decimalsByAsset: {},
    };
  }

  const uniqueAssets = new Set<Address>();
  for (const snap of snapshots) {
    for (const p of snap.positions) {
      uniqueAssets.add(p.collateralAsset as Address);
      uniqueAssets.add(p.debtAsset as Address);
    }
  }

  const crossChainAssetMap = config.dataSources.chainlinkApi.crossChainAssetMap ?? {};
  const canonicalByAsset = new Map<Address, Address>();
  const canonicalAssets = new Set<Address>();
  for (const asset of uniqueAssets) {
    const canonical = canonicalizeAsset(asset, crossChainAssetMap);
    canonicalByAsset.set(asset.toLowerCase() as Address, canonical);
    canonicalAssets.add(canonical);
    if (canonical !== (asset.toLowerCase() as Address)) {
      runtime.log(`[V1][asset-map] ${asset.toLowerCase()} -> ${canonical}`);
    }
  }

  const reports = loadReportsWithFallback(
    runtime,
    config,
    priceReadChain,
    Array.from(canonicalAssets)
  );
  const priceByAsset: Record<string, string> = {};
  const canonicalReportMap = new Map<Address, PriceReport>();
  const reportMap = new Map<Address, PriceReport>();
  for (const report of reports) {
    canonicalReportMap.set(report.asset.toLowerCase() as Address, report);
  }
  for (const asset of uniqueAssets) {
    const normalizedAsset = asset.toLowerCase() as Address;
    const canonicalAsset =
      canonicalByAsset.get(normalizedAsset) ?? normalizedAsset;
    const canonicalReport = canonicalReportMap.get(canonicalAsset);
    if (!canonicalReport) {
      continue;
    }
    const remappedReport: PriceReport = {
      ...canonicalReport,
      asset: normalizedAsset,
    };
    reportMap.set(normalizedAsset, remappedReport);
    priceByAsset[normalizedAsset] = canonicalReport.priceUsd;
  }

  let missingPriceCount = 0;
  let invalidReportCount = 0;
  let staleReportCount = 0;
  let maxShockBps = 0;
  let maxStalenessPenaltyBps = 0n;
  const nowSec = Math.floor(Date.now() / 1000);
  const maxPriceAgeSec = config.dataSources.chainlinkApi.maxPriceAgeSec;
  const stalenessChecksEnabled = maxPriceAgeSec > 0;

  if (!stalenessChecksEnabled) {
    runtime.log("[V1] Staleness checks disabled (maxPriceAgeSec=0).");
  }

  for (const asset of uniqueAssets) {
    const report = reportMap.get(asset.toLowerCase() as Address);
    if (!report) {
      runtime.log(`[V1][price] missing asset=${asset}`);
      missingPriceCount += 1;
      continue;
    }

    const ageSec = nowSec - report.updatedAt;
    const shock = computeShockBps(report);
    runtime.log(
      `[V1][price] asset=${asset} priceUsd=${report.priceUsd} source=${report.source} ageSec=${ageSec} shockBps=${shock}`
    );
    const isStale = stalenessChecksEnabled && ageSec > maxPriceAgeSec;
    if (isStale) {
      staleReportCount += 1;
      if (stalePolicy === "ABORT") {
        continue;
      }
      runtime.log(
        `[V1] WARN_ONLY: stale price report accepted asset=${asset} ageSec=${ageSec}`
      );
    }

    if (report.source === "api") {
      if (!verifyReportIntegrity(report, config.dataSources.chainlinkApi.integritySalt)) {
        invalidReportCount += 1;
        continue;
      }
    }

    const stalenessPenalty = stalenessChecksEnabled
      ? (BigInt(ageSec) * BigInt(config.thresholds.stalePricePenaltyBps)) / BigInt(maxPriceAgeSec)
      : 0n;
    if (stalenessPenalty > maxStalenessPenaltyBps) {
      maxStalenessPenaltyBps = stalenessPenalty;
    }

    if (shock > maxShockBps) {
      maxShockBps = shock;
    }
  }

  if (missingPriceCount > 0 && config.monitoring.abortOnMissingPrice) {
    runtime.log(`[V1] Abort: missing prices for ${missingPriceCount} assets.`);
    return {
      decision: "ABORT",
      reason: `Missing prices for ${missingPriceCount} assets`,
      metadata: { missingPriceCount },
      snapshots,
      priceByAsset,
      decimalsByAsset,
    };
  }

  if (stalenessChecksEnabled && staleReportCount > 0) {
    if (stalePolicy === "ABORT") {
      runtime.log(`[V1] Abort: stale reports count=${staleReportCount}.`);
      return {
        decision: "ABORT",
        reason: `Stale reports detected: ${staleReportCount}`,
        metadata: { staleReportCount, stalePolicy },
        snapshots,
        priceByAsset,
        decimalsByAsset,
      };
    }
    runtime.log(`[V1] WARN_ONLY: stale reports count=${staleReportCount}.`);
  }

  if (invalidReportCount > 0) {
    runtime.log(`[V1] Abort: integrity verification failures=${invalidReportCount}.`);
    return {
      decision: "ABORT",
      reason: `Integrity verification failed for ${invalidReportCount} reports`,
      metadata: { invalidReportCount },
      snapshots,
      priceByAsset,
      decimalsByAsset,
    };
  }

  if (maxShockBps >= config.monitoring.priceShockAbortBps) {
    runtime.log(
      `[V1] Abort: max shock ${maxShockBps} bps exceeded threshold ${config.monitoring.priceShockAbortBps} bps.`
    );
    return {
      decision: "ABORT",
      reason: `Price shock exceeded abort threshold (${maxShockBps} bps)`,
      metadata: { maxShockBps, thresholdBps: config.monitoring.priceShockAbortBps },
      snapshots,
      priceByAsset,
      decimalsByAsset,
    };
  }

  let decimalsReadErrors = 0;
  const readDecimalsCached = (asset: Address): number => {
    const key = asset.toLowerCase() as Address;
    const cached = decimalsCache.get(key);
    if (cached !== undefined) return cached;
    const fromPositions = decimalsByAsset[key];
    if (typeof fromPositions === "number" && fromPositions > 0) {
      decimalsCache.set(key, fromPositions);
      return fromPositions;
    }
    let value = 18;
    try {
      value = readTokenDecimals(runtime, priceReadChain, key);
    } catch {
      decimalsReadErrors += 1;
    }
    decimalsCache.set(key, value);
    decimalsByAsset[key] = value;
    return value;
  };

  let totalEffectiveCollateralUsdWad = 0n;
  let totalDebtUsdWad = 0n;
  let positionsAnalyzed = 0;
  let weakestDebtHfWad = MAX_HF_WAD;
  let weakestPositionLabel = "";
  let weakestPositionChainId: number | undefined;
  let weakestPositionChainKey: string | undefined;
  runtime.log(`[V1] User=${user} adaptersWithPositions=${snapshots.length}`);

  for (const snap of snapshots) {
    for (const p of snap.positions) {
      const collateralAsset = (p.collateralAsset as Address).toLowerCase() as Address;
      const debtAsset = (p.debtAsset as Address).toLowerCase() as Address;

      const collateralReport = reportMap.get(collateralAsset);
      const debtReport = reportMap.get(debtAsset);
      if (!collateralReport || !debtReport) {
        continue;
      }

      const collateralPriceWad = parseUsdToWad(collateralReport.priceUsd);
      const debtPriceWad = parseUsdToWad(debtReport.priceUsd);
      const collateralDecimals = readDecimalsCached(collateralAsset);
      const debtDecimals = readDecimalsCached(debtAsset);

      const collateralUsdWad =
        (p.collateralAmount * collateralPriceWad) / (10n ** BigInt(collateralDecimals));
      const debtUsdWad = (p.debtAmount * debtPriceWad) / (10n ** BigInt(debtDecimals));

      const effectiveCollateralUsdWad =
        (collateralUsdWad * p.liquidationThresholdBps) / BPS_DENOM;
      const positionHfWad =
        debtUsdWad == 0n ? MAX_HF_WAD : (effectiveCollateralUsdWad * WAD) / debtUsdWad;

      if (debtUsdWad > 0n && positionHfWad < weakestDebtHfWad) {
        weakestDebtHfWad = positionHfWad;
        weakestPositionLabel = snap.label;
        weakestPositionChainId = snap.chainId;
        weakestPositionChainKey = snap.chainKey;
      }

      totalEffectiveCollateralUsdWad += effectiveCollateralUsdWad;
      totalDebtUsdWad += debtUsdWad;
      positionsAnalyzed += 1;

      runtime.log(
        `[V1][position] adapter=${snap.label} collAsset=${collateralAsset} debtAsset=${debtAsset} collAmt=${formatUnits(
          p.collateralAmount,
          collateralDecimals,
          4
        )} debtAmt=${formatUnits(p.debtAmount, debtDecimals, 4)} collUsd=${formatUnits(
          collateralUsdWad,
          18,
          2
        )} debtUsd=${formatUnits(debtUsdWad, 18, 2)} effCollUsd=${formatUnits(
          effectiveCollateralUsdWad,
          18,
          2
        )} positionHF=${formatHf(positionHfWad)}`
      );
    }
  }

  const aggregateHfWad =
    totalDebtUsdWad === 0n
      ? MAX_HF_WAD
      : (totalEffectiveCollateralUsdWad * WAD) / totalDebtUsdWad;

  const slopePenaltyBps = BigInt(
    Math.min(config.thresholds.slopePenaltyBps, Math.floor(maxShockBps / 2))
  );

  const totalPenaltyBps =
    maxStalenessPenaltyBps + slopePenaltyBps > MAX_PENALTY_BPS
      ? MAX_PENALTY_BPS
      : maxStalenessPenaltyBps + slopePenaltyBps;

  const effectiveHfWad = (aggregateHfWad * (BPS_DENOM - totalPenaltyBps)) / BPS_DENOM;
  const weakestEffectiveHfWad =
    weakestDebtHfWad >= MAX_HF_WAD / 2n
      ? MAX_HF_WAD
      : (weakestDebtHfWad * (BPS_DENOM - totalPenaltyBps)) / BPS_DENOM;

  const decision = evaluateDecision(
    weakestEffectiveHfWad,
    config,
    snapshots,
    weakestPositionChainId,
    weakestPositionChainKey
  );
  const aggregateHf = formatHf(aggregateHfWad);
  const effectiveHf = formatHf(effectiveHfWad);
  const weakestHf = formatHf(weakestDebtHfWad);
  const weakestEffectiveHf = formatHf(weakestEffectiveHfWad);
  const totalEffectiveCollateralUsd = formatUnits(totalEffectiveCollateralUsdWad, 18, 2);
  const totalDebtUsd = formatUnits(totalDebtUsdWad, 18, 2);

  runtime.log(
    `[V1][summary] positions=${positionsAnalyzed} totalEffectiveCollUsd=${totalEffectiveCollateralUsd} totalDebtUsd=${totalDebtUsd} aggregateHF=${aggregateHf} weakestHF=${weakestHf} stalenessPenaltyBps=${Number(
      maxStalenessPenaltyBps
    )} slopePenaltyBps=${Number(slopePenaltyBps)} effectiveHF=${effectiveHf} weakestEffectiveHF=${weakestEffectiveHf} decision=${decision}`
  );

  return {
    decision,
    reason: `Guard evaluated with weakest effective HF ${weakestEffectiveHf} (aggregate ${effectiveHf})`,
    metadata: {
      user,
      positionSource,
      adaptersMonitored: snapshots.length,
      positionsAnalyzed,
      reportsUsed: reports.length,
      aggregateHf,
      effectiveHf,
      weakestHf,
      weakestEffectiveHf,
      weakestPositionLabel,
      totalEffectiveCollateralUsd,
      totalDebtUsd,
      stalenessPenaltyBps: Number(maxStalenessPenaltyBps),
      slopePenaltyBps: Number(slopePenaltyBps),
      maxShockBps,
      stalePolicy,
      staleReportCount,
      adapterReadErrors: adapterReadErrors.length,
      decimalsReadErrors,
    },
    snapshots,
    priceByAsset,
    decimalsByAsset,
  };
};

export const __testables = {
  parseUsdToWad,
  buildIntegrityHash,
  verifyReportIntegrity,
  bpsToWad,
  computeShockBps,
  decideRoute,
};
