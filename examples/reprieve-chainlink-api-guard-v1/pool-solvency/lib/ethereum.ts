// ==========================================================================
// Pool Solvency EVM Interaction Helpers
// ==========================================================================

import {
  cre,
  type Runtime,
  getNetwork,
  bytesToHex,
  hexToBase64,
  encodeCallMsg,
  LAST_FINALIZED_BLOCK_NUMBER,
} from "@chainlink/cre-sdk";
import {
  encodeAbiParameters,
  parseAbiParameters,
  encodeFunctionData,
  decodeFunctionResult,
  parseAbi,
  zeroAddress,
  type Address,
} from "viem";
import type { Config, EvmConfig } from "../types";

// ========================================
// Retry Utility
// ========================================

export const withRetry = async <T>(
  fn: () => Promise<T>,
  maxRetries = 3
): Promise<T> => {
  let lastError: Error | undefined;
  
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      // Continue to next retry (no delay in CRE WASM environment)
    }
  }
  
  throw lastError;
};

// ========================================
// EVM Client Factory
// ========================================

export const createEvmClient = (chainSelectorName: string, isTestnet = true) => {
  const network = getNetwork({
    chainFamily: "evm",
    chainSelectorName,
    isTestnet,
  });

  if (!network) {
    throw new Error(`Network not found: ${chainSelectorName}`);
  }

  return new cre.capabilities.EVMClient(network.chainSelector.selector);
};

// ========================================
// Solvency Report Type
// ========================================

export interface SolvencyReportPayload {
  epochId: number;
  poolBalance: bigint;
  totalLiability: bigint;
  utilizationBps: number;
  maxSingleBetExposure: bigint;
}

const ERC20_ABI = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
]);

const POOL_RESERVE_ABI = parseAbi([
  "function latestSolvencyEpochId() view returns (uint256)",
]);

// ========================================
// Encode Solvency Report
// ========================================

export const encodeSolvencyReport = (payload: SolvencyReportPayload): `0x${string}` => {
  return encodeAbiParameters(
    parseAbiParameters([
      "uint256 epochId",
      "uint256 poolBalance",
      "uint256 totalLiability",
      "uint256 utilizationBps",
      "uint256 maxSingleBetExposure",
    ]),
    [
      BigInt(payload.epochId),
      payload.poolBalance,
      payload.totalLiability,
      BigInt(payload.utilizationBps),
      payload.maxSingleBetExposure,
    ]
  );
};

// ========================================
// Submit Solvency Report
// ========================================

export const submitSolvencyReport = (
  runtime: Runtime<Config>,
  evmConfig: EvmConfig,
  payload: SolvencyReportPayload
): string => {
  const evmClient = createEvmClient(evmConfig.chainSelectorName);
  const reportData = encodeSolvencyReport(payload);

  runtime.log(`Submitting solvency report`);
  runtime.log(`Epoch ID: ${payload.epochId}`);
  runtime.log(`Pool Balance: ${payload.poolBalance.toString()}`);
  runtime.log(`Total Liability: ${payload.totalLiability.toString()}`);
  runtime.log(`Utilization: ${payload.utilizationBps} bps`);

  // Sign the report
  const reportResponse = runtime
    .report({
      encodedPayload: hexToBase64(reportData),
      encoderName: "evm",
      signingAlgo: "ecdsa",
      hashingAlgo: "keccak256",
    })
    .result();

  // Submit to contract
  const writeResult = evmClient
    .writeReport(runtime, {
      receiver: evmConfig.poolReserveAddress,
      report: reportResponse,
      gasConfig: {
        gasLimit: evmConfig.gasLimit,
      },
    })
    .result();

  const txHash = bytesToHex(writeResult.txHash ?? new Uint8Array(32));
  runtime.log(`Solvency report submitted. Tx: ${txHash}`);

  return txHash;
};

// ========================================
// Read Pool Balance
// ========================================

export const readPoolBalance = (
  runtime: Runtime<Config>,
  evmConfig: EvmConfig
): bigint => {
  runtime.log(`Reading pool balance via ERC20.balanceOf(poolReserveAddress)`);

  const evmClient = createEvmClient(evmConfig.chainSelectorName);
  const poolReserveAddress = evmConfig.poolReserveAddress as Address;
  const assetAddress = evmConfig.assetAddress as Address;

  const calldata = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [poolReserveAddress],
  });

  const contractCall = evmClient
    .callContract(runtime, {
      call: encodeCallMsg({
        from: zeroAddress,
        to: assetAddress,
        data: calldata,
      }),
      blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
    })
    .result();

  const poolBalance = decodeFunctionResult({
    abi: ERC20_ABI,
    functionName: "balanceOf",
    data: bytesToHex(contractCall.data),
  }) as bigint;

  runtime.log(`Pool balance read: ${poolBalance.toString()} (asset: ${evmConfig.assetAddress})`);
  return poolBalance;
};

// ========================================
// Read Latest Solvency Epoch
// ========================================

export const readLatestSolvencyEpochId = (
  runtime: Runtime<Config>,
  evmConfig: EvmConfig
): number => {
  runtime.log(`Reading latestSolvencyEpochId from PoolReserve`);

  const evmClient = createEvmClient(evmConfig.chainSelectorName);
  const poolReserveAddress = evmConfig.poolReserveAddress as Address;

  const calldata = encodeFunctionData({
    abi: POOL_RESERVE_ABI,
    functionName: "latestSolvencyEpochId",
  });

  try {
    const contractCall = evmClient
      .callContract(runtime, {
        call: encodeCallMsg({
          from: zeroAddress,
          to: poolReserveAddress,
          data: calldata,
        }),
        blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
      })
      .result();

    const resultHex = bytesToHex(contractCall.data);
    
    // Handle empty response (contract returns 0x when no data)
    if (resultHex === "0x" || resultHex === "0x0") {
      runtime.log(`latestSolvencyEpochId: 0 (empty response, first report)`);
      return 0;
    }

    const latestEpochId = decodeFunctionResult({
      abi: POOL_RESERVE_ABI,
      functionName: "latestSolvencyEpochId",
      data: resultHex,
    }) as bigint;

    runtime.log(`latestSolvencyEpochId: ${latestEpochId.toString()}`);
    return Number(latestEpochId);
  } catch (error) {
    // If call fails (e.g., contract not deployed or no data), return 0 as default
    runtime.log(`Failed to read latestSolvencyEpochId, defaulting to 0: ${error}`);
    return 0;
  }
};
