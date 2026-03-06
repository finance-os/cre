// ==========================================================================
// Pool Solvency API Client
// ==========================================================================

import type { LiabilityResponse } from "../types";

// ========================================
// API Client Interface
// ========================================

export interface SolvencyApiClient {
  getLiabilityData(): Promise<LiabilityResponse>;
  sendAlert(message: string, severity: "low" | "medium" | "high" | "critical"): Promise<void>;
}

// ========================================
// Real API Client
// ========================================

export class RealSolvencyApiClient implements SolvencyApiClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
  }

  private async fetch<T>(path: string, options?: RequestInit): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        ...options?.headers,
      },
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: response.statusText })) as { message: string };
      throw new Error(`API error: ${response.status} - ${error.message}`);
    }

    return response.json() as Promise<T>;
  }

  async getLiabilityData(): Promise<LiabilityResponse> {
    return this.fetch<LiabilityResponse>(`/risk/liability`);
  }

  async sendAlert(message: string, severity: "low" | "medium" | "high" | "critical"): Promise<void> {
    await this.fetch(`/alerts`, {
      method: "POST",
      body: JSON.stringify({
        message,
        severity,
        source: "pool-solvency-workflow",
        timestamp: Math.floor(Date.now() / 1000),
      }),
    });
  }
}

// ========================================
// Mock API Client
// ========================================

export class MockSolvencyApiClient implements SolvencyApiClient {
  public isHealthy = true; // Toggle to simulate unhealthy state

  private seededRandom(seed: number): number {
    const x = Math.sin(seed * 9999) * 10000;
    return x - Math.floor(x);
  }

  async getLiabilityData(): Promise<LiabilityResponse> {
    const seed = Math.floor(Date.now() / 86400000); // Daily seed

    // Simulate healthy vs unhealthy scenarios
    const baseLiability = this.isHealthy ? 50000 : 90000; // USDT
    const baseExposure = this.isHealthy ? 5000 : 15000;

    return {
      timestamp: Math.floor(Date.now() / 1000),
      totalLiability: (BigInt(Math.floor(this.seededRandom(seed) * baseLiability)) * BigInt(1e18)).toString(),
      utilizationBps: Math.floor(this.seededRandom(seed + 1) * 1000) + (this.isHealthy ? 500 : 1500), // 5-15% or 15-25%
      maxSingleBetExposure: (BigInt(Math.floor(this.seededRandom(seed + 2) * baseExposure)) * BigInt(1e18)).toString(),
      outstandingBets: Math.floor(this.seededRandom(seed + 3) * 100) + 50,
    };
  }

  async sendAlert(message: string, severity: "low" | "medium" | "high" | "critical"): Promise<void> {
    console.log(`[ALERT:${severity.toUpperCase()}] ${message}`);
    // No-op in mock
  }
}

// ========================================
// Factory
// ========================================

export const createApiClient = (baseUrl: string, apiKey: string, useMock = false): SolvencyApiClient => {
  // Always use mock in CRE WASM environment (fetch not available)
  // In production deployment, this would use the CRE HTTP capability
  if (useMock || baseUrl.includes("localhost") || typeof fetch === "undefined") {
    return new MockSolvencyApiClient();
  }
  return new RealSolvencyApiClient(baseUrl, apiKey);
};
