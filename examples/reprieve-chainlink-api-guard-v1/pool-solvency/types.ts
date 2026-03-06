// ==========================================================================
// Pool Solvency Workflow Types
// ==========================================================================

import { z } from "zod";

// ========================================
// EVM Configuration
// ========================================

export const evmConfigSchema = z.object({
  chainSelectorName: z.string(),
  chainId: z.number(),
  poolReserveAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  assetAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  gasLimit: z.string().optional(),
});

export type EvmConfig = z.infer<typeof evmConfigSchema>;

// ========================================
// Main Config
// ========================================

export const configSchema = z.object({
  appApiBaseUrl: z.string().url(),
  evms: z.array(evmConfigSchema),
  minSolvencyRatio: z.string().optional(), // Defaults to 1.5e18
  owner: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(), // EVM address for vault DON secrets ownership
});

export type Config = z.infer<typeof configSchema>;

// ========================================
// Helper: Get EVM Config
// ========================================

export const getEvmConfig = (config: Config): EvmConfig => {
  if (config.evms.length === 0) {
    throw new Error("No EVM configuration found");
  }
  return config.evms[0];
};

// ========================================
// Pool Solvency Types
// ========================================

export const liabilityResponseSchema = z.object({
  timestamp: z.number(),
  totalLiability: z.string(), // bigint as string
  utilizationBps: z.number(),
  maxSingleBetExposure: z.string(), // bigint as string
  outstandingBets: z.number(),
});

export type LiabilityResponse = z.infer<typeof liabilityResponseSchema>;

export interface SolvencyReport {
  epochId: number;
  poolBalance: bigint;
  totalLiability: bigint;
  solvencyRatio: bigint; // 1e18 precision
  utilizationBps: number;
  maxSingleBetExposure: bigint;
  timestamp: number;
  isHealthy: boolean;
}

// Minimum solvency ratio (1.5x = 1.5e18)
export const MIN_SOLVENCY_RATIO = 1500000000000000000n; // 1.5e18
export const RATIO_PRECISION = 1000000000000000000n; // 1e18
