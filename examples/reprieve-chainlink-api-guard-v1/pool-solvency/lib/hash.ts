// ==========================================================================
// Deterministic Hashing Utilities for Tap.fun CRE Workflows
// ==========================================================================

import { keccak256, toHex, encodeAbiParameters, parseAbiParameters } from "viem";
import { Candle } from "../types";

// ========================================
// Candle Hashing
// ========================================

/**
 * Hash a single candle deterministically
 */
export const hashCandle = (candle: Candle): `0x${string}` => {
  const data = encodeAbiParameters(
    parseAbiParameters([
      "uint256 timestamp",
      "string open",
      "string high",
      "string low",
      "string close",
    ]),
    [
      BigInt(candle.timestamp),
      candle.open,
      candle.high,
      candle.low,
      candle.close,
    ]
  );
  
  return keccak256(data);
};

/**
 * Hash an array of candles (Merkle root style)
 */
export const hashCandles = (candles: Candle[]): `0x${string}` => {
  if (candles.length === 0) {
    return keccak256(toHex("empty_candles"));
  }

  // Sort by timestamp for determinism
  const sorted = [...candles].sort((a, b) => a.timestamp - b.timestamp);
  
  // Hash each candle
  const leaves = sorted.map(hashCandle);
  
  // Compute Merkle root
  return computeMerkleRoot(leaves);
};

// ========================================
// Merkle Tree
// ========================================

/**
 * Compute Merkle root from leaf hashes
 */
export const computeMerkleRoot = (leaves: `0x${string}`[]): `0x${string}` => {
  if (leaves.length === 0) {
    return keccak256(toHex(""));
  }

  let currentLevel = [...leaves];
  
  while (currentLevel.length > 1) {
    const nextLevel: `0x${string}`[] = [];
    
    for (let i = 0; i < currentLevel.length; i += 2) {
      const left = currentLevel[i];
      // If odd number, duplicate the last element
      const right = currentLevel[i + 1] || left;
      
      // Sort for determinism (smaller hash first)
      const [a, b] = left < right ? [left, right] : [right, left];
      
      // Combine and hash
      const combined = keccak256(
        encodeAbiParameters(
          parseAbiParameters(["bytes32 a", "bytes32 b"]),
          [a, b]
        )
      );
      
      nextLevel.push(combined);
    }
    
    currentLevel = nextLevel;
  }

  return currentLevel[0];
};

// ========================================
// Diff Merkle Root (for Price Integrity)
// ========================================

/**
 * Compute diff Merkle root for candle differences
 */
export const computeDiffMerkleRoot = (
  internalCandles: Candle[],
  chainlinkCandles: Candle[]
): `0x${string}` => {
  // Sort both by timestamp
  const internal = [...internalCandles].sort((a, b) => a.timestamp - b.timestamp);
  const chainlink = [...chainlinkCandles].sort((a, b) => a.timestamp - b.timestamp);
  
  // Compute diff for each candle pair
  const diffs: `0x${string}`[] = [];
  
  for (let i = 0; i < Math.min(internal.length, chainlink.length); i++) {
    const int = internal[i];
    const cl = chainlink[i];
    
    const diffData = encodeAbiParameters(
      parseAbiParameters([
        "uint256 timestamp",
        "int256 openDiff",
        "int256 highDiff",
        "int256 lowDiff",
        "int256 closeDiff",
      ]),
      [
        BigInt(int.timestamp),
        BigInt(Math.floor((parseFloat(int.open) - parseFloat(cl.open)) * 1e8)),
        BigInt(Math.floor((parseFloat(int.high) - parseFloat(cl.high)) * 1e8)),
        BigInt(Math.floor((parseFloat(int.low) - parseFloat(cl.low)) * 1e8)),
        BigInt(Math.floor((parseFloat(int.close) - parseFloat(cl.close)) * 1e8)),
      ]
    );
    
    diffs.push(keccak256(diffData));
  }
  
  return computeMerkleRoot(diffs);
};

// ========================================
// Settlement Merkle Tree
// ========================================

export interface SettlementLeaf {
  account: `0x${string}`;
  netAmount: bigint; // Positive for win, negative for loss
}

/**
 * Build settlement Merkle tree leaves
 */
export const buildSettlementLeaves = (
  accounts: string[],
  payouts: bigint[],
  stakes: bigint[]
): SettlementLeaf[] => {
  const leaves: SettlementLeaf[] = [];
  
  for (let i = 0; i < accounts.length; i++) {
    const netAmount = payouts[i] - stakes[i];
    leaves.push({
      account: accounts[i] as `0x${string}`,
      netAmount,
    });
  }
  
  // Sort by account for determinism
  return leaves.sort((a, b) => a.account.localeCompare(b.account));
};

/**
 * Hash settlement leaf
 */
export const hashSettlementLeaf = (leaf: SettlementLeaf): `0x${string}` => {
  const data = encodeAbiParameters(
    parseAbiParameters(["address account", "int256 netAmount"]),
    [leaf.account, leaf.netAmount]
  );
  
  return keccak256(data);
};

/**
 * Compute settlement Merkle root
 */
export const computeSettlementMerkleRoot = (leaves: SettlementLeaf[]): `0x${string}` => {
  const hashes = leaves.map(hashSettlementLeaf);
  return computeMerkleRoot(hashes);
};

// ========================================
// Idempotency Keys
// ========================================

/**
 * Generate idempotency key for price integrity
 */
export const priceIntegrityIdempotencyKey = (
  chainId: number,
  epochId: number
): string => {
  return `pi_${chainId}_${epochId}`;
};

/**
 * Generate idempotency key for settlement
 */
export const settlementIdempotencyKey = (
  chainId: number,
  batchId: string
): string => {
  return `st_${chainId}_${batchId}`;
};

/**
 * Generate idempotency key for solvency
 */
export const solvencyIdempotencyKey = (
  chainId: number,
  epochId: number
): string => {
  return `sv_${chainId}_${epochId}`;
};
