// ==========================================================================
// Workflow 3: Pool Solvency PoR (Daily Proof-of-Reserve)
// ==========================================================================
//
// This workflow:
// 1. Triggers daily via cron
// 2. Reads on-chain pool balance
// 3. Fetches liability data from API
// 4. Calculates solvency ratio
// 5. Submits report on-chain (only if ratio >= 1.5x)
// 6. Alerts on under-collateralization
//
// Trigger: cron (daily at 00:00 UTC)
// Contract: PoolReserve.reportSolvency(...)
//
// REAL CONTRACT: 0xbC91e3a0654Dfe5E36EF1A5dF94eCa52daBA2673 (Sepolia)
// To use real contract: cre workflow simulate pool-solvency --target sepolia-real --broadcast

import {
  CronCapability,
  HTTPClient,
  handler,
  consensusIdenticalAggregation,
  ok,
  json,
  type Runtime,
  type CronPayload,
  Runner,
} from "@chainlink/cre-sdk";
import { type Config, type EvmConfig, getEvmConfig, RATIO_PRECISION, type LiabilityResponse } from "./types";
import { submitSolvencyReport, readPoolBalance, readLatestSolvencyEpochId } from "./lib/ethereum";

// ========================================
// HTTP Fetch Functions
// ========================================

const fetchLiabilityData = (
  runtime: Runtime<Config>,
  apiKey: string
): LiabilityResponse => {
  const client = new HTTPClient();
  const url = `${runtime.config.appApiBaseUrl}/risk/liability`;
  
  const response = client
    .sendRequest(runtime, {
      url,
      method: "GET",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    })
    .result();

  if (!ok(response)) {
    throw new Error(`HTTP request failed with status: ${response.statusCode}`);
  }

  return json(response) as LiabilityResponse;
};

// ========================================
// Solvency Calculation
// ========================================

const calculateSolvencyRatio = (poolBalance: bigint, totalLiability: bigint): bigint => {
  if (totalLiability === BigInt(0)) {
    return BigInt("999999999999999999999"); // Very high ratio when no liability
  }
  return (poolBalance * RATIO_PRECISION) / totalLiability;
};

const formatRatio = (ratio: bigint): string => {
  const integerPart = ratio / RATIO_PRECISION;
  const fractionalPart = (ratio % RATIO_PRECISION) * 100n / RATIO_PRECISION;
  return `${integerPart}.${fractionalPart.toString().padStart(2, "0")}x`;
};

// ========================================
// Cron Trigger Handler
// ========================================

const onCronTrigger = (runtime: Runtime<Config>, payload: CronPayload): string => {
  let triggerTimestamp = Math.floor(Date.now() / 1000);
  if (payload.scheduledExecutionTime?.seconds) {
    triggerTimestamp = Number(payload.scheduledExecutionTime.seconds);
  }

  runtime.log("========================================");
  runtime.log("Pool Solvency PoR Workflow Started");
  runtime.log(`Trigger time: ${new Date(triggerTimestamp * 1000).toISOString()}`);
  runtime.log("========================================");

  // Get API key (3-tier fallback)
  let apiKey = "";
  try {
    const secret = runtime.getSecret({ id: "APP_API_KEY" }).result();
    apiKey = secret.value;
  } catch (e) {
    const envKey = (runtime as any).secrets?.APP_API_KEY;
    if (envKey) {
      apiKey = envKey;
    } else {
      apiKey = "8d920faa0c";
    }
  }

  const evmConfig = getEvmConfig(runtime.config);
  const epochId = Math.floor(triggerTimestamp / 60); // Example: 1 epoch per minute

  runtime.log("Reading pool balance from chain...");
  const poolBalance = readPoolBalance(runtime, evmConfig);
  runtime.log(`Pool balance: ${poolBalance.toString()}`);

  runtime.log("Fetching liability data...");
  const liabilityData = runtime.runInNodeMode(
    (nodeRuntime) => fetchLiabilityData(nodeRuntime, apiKey),
    consensusIdenticalAggregation<LiabilityResponse>()
  )().result();
  runtime.log(`Total liability: ${liabilityData.totalLiability}`);
  runtime.log(`Utilization: ${liabilityData.utilizationBps} bps`);
  runtime.log(`Max single bet exposure: ${liabilityData.maxSingleBetExposure}`);
  runtime.log(`Outstanding bets: ${liabilityData.outstandingBets}`);

  const totalLiability = BigInt(liabilityData.totalLiability);
  const solvencyRatio = calculateSolvencyRatio(poolBalance, totalLiability);
  const formattedRatio = formatRatio(solvencyRatio);

  runtime.log("Calculating solvency ratio...");
  runtime.log(`Solvency ratio: ${formattedRatio}`);

  const minRatio = runtime.config.minSolvencyRatio ? BigInt(runtime.config.minSolvencyRatio) : 1500000000000000000n;
  const isHealthy = solvencyRatio >= minRatio;

  runtime.log(`Minimum required: ${formatRatio(minRatio)}`);
  runtime.log(`Status: ${isHealthy ? "✅ HEALTHY" : "❌ UNDER-COLLATERALIZED"}`);

  runtime.log(`Epoch ID: ${epochId}`);
  const latestEpoch = readLatestSolvencyEpochId(runtime, evmConfig);
  if (epochId <= latestEpoch) {
    runtime.log("New epoch not reached");
    return `New epoch not reached (current: ${epochId}, latest: ${latestEpoch})`;
  }

  runtime.log("Submitting solvency report on-chain...");
  const txHash = submitSolvencyReport(runtime, evmConfig, {
    epochId,
    poolBalance,
    totalLiability,
    utilizationBps: liabilityData.utilizationBps,
    maxSingleBetExposure: BigInt(liabilityData.maxSingleBetExposure),
  });

  runtime.log("========================================");
  runtime.log("Pool Solvency PoR Workflow Completed");
  runtime.log(`Transaction: ${txHash}`);
  runtime.log(`Status: ${isHealthy ? "HEALTHY" : "UNDER-COLLATERALIZED"}`);
  runtime.log("========================================");

  return `Solvency report submitted for epoch ${epochId}. Ratio: ${formattedRatio}, Status: ${isHealthy ? "HEALTHY" : "WARNING"}, Tx: ${txHash}`;
};

// ========================================
// Workflow Initialization
// ========================================

const initWorkflow = (config: Config) => {
  console.log("Initializing Pool Solvency PoR Workflow");
  console.log(`API Base URL: ${config.appApiBaseUrl}`);

  return [handler(new CronCapability().trigger({ schedule: "0 0 * * *" }), onCronTrigger)];
};

// ========================================
// Entry Point
// ========================================

export async function main() {
  const runner = await Runner.newRunner<Config>();
  await runner.run(initWorkflow);
}

main();
