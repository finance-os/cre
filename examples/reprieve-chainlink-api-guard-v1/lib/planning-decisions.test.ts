import { describe, expect, test } from "bun:test";
import { __testables as riskTestables } from "./risk-v1";
import { __testables as flowTestables } from "./full-flow-v1";

const WAD = 10n ** 18n;
const HF_MAX = (2n ** 255n) - 1n;

const bpsToWad = (bps: number): bigint => BigInt(bps) * 10n ** 14n;

const hfFromUsd = (
  collateralUsdWad: bigint,
  debtUsdWad: bigint,
  liquidationThresholdBps = 8000
): bigint => {
  if (debtUsdWad === 0n) return HF_MAX;
  const effectiveCollateral = (collateralUsdWad * BigInt(liquidationThresholdBps)) / 10000n;
  return (effectiveCollateral * WAD) / debtUsdWad;
};

describe("route decision from position risk", () => {
  test("chooses RESCUE_CROSS_CHAIN when weakest position is on dst and healthy collateral source is on src", () => {
    // Target (Base): coll=14k, debt=10k => HF ~= 1.12
    const weakestHf = hfFromUsd(14_000n * WAD, 10_000n * WAD, 8000);

    const decision = riskTestables.decideRoute(
      weakestHf,
      bpsToWad(10000), // onchainHfMin = 1.00
      bpsToWad(11250), // earlyWarning = 1.125
      true, // allowCrossChain
      true // chain-aware source exists on another chain
    );

    expect(decision).toBe("RESCUE_CROSS_CHAIN");
  });

  test("chooses RESCUE_SAME_CHAIN when no cross-chain source exists", () => {
    const weakestHf = hfFromUsd(14_000n * WAD, 10_000n * WAD, 8000);

    const decision = riskTestables.decideRoute(
      weakestHf,
      bpsToWad(10000),
      bpsToWad(11250),
      true,
      false // only same-chain sources available
    );

    expect(decision).toBe("RESCUE_SAME_CHAIN");
  });

  test("chooses NO_ACTION when weakest HF is above early warning threshold", () => {
    // coll=20k, debt=10k => HF ~= 1.6
    const safeHf = hfFromUsd(20_000n * WAD, 10_000n * WAD, 8000);

    const decision = riskTestables.decideRoute(
      safeHf,
      bpsToWad(10000),
      bpsToWad(11250),
      true,
      true
    );

    expect(decision).toBe("NO_ACTION");
  });
});

describe("rescue mode inference", () => {
  const ETH_WETH = "0x4c87EA388AdE37f6A556146B4fF6ff2A12192968";
  const ETH_USDC = "0x7C31b54EB6712B308cf27aA7e8d2012DcfA92E4E";
  const BASE_WETH = "0xEDD391FDa28993287Df301485ABF72865dee5050";
  const BASE_USDC = "0x7570E1f97e0831E929B9525858586E274F5C9cf2";

  const mapping = {
    [BASE_WETH.toLowerCase()]: ETH_WETH.toLowerCase(),
    [BASE_USDC.toLowerCase()]: ETH_USDC.toLowerCase(),
  };

  const mkFlat = (collateralAsset: string, debtAsset: string) =>
    ({
      label: "test",
      adapterAddress: "0x1111111111111111111111111111111111111111",
      availableCollateral: 10n * WAD,
      chainId: 1,
      chainKey: "chain",
      isConfiguredAdapter: true,
      position: {
        protocol: "0x0000000000000000000000000000000000000000",
        collateralAsset,
        debtAsset,
        collateralAmount: 10n * WAD,
        debtAmount: 5_000_000_000n, // just to keep position realistic
        healthFactor: WAD,
        ltvBps: 7500n,
        maxLtvBps: 7500n,
        liquidationThresholdBps: 8000n,
      },
    } as const);

  test("infers TOP_UP for same-direction positions (lend WETH / borrow USDC on both legs)", () => {
    const source = mkFlat(ETH_WETH, ETH_USDC);
    const target = mkFlat(BASE_WETH, BASE_USDC);

    const mode = flowTestables.inferRescueModeFromPositions(source as never, target as never, mapping);
    expect(mode).toBe("TOP_UP");
  });

  test("infers REPAY for opposite-direction hedge positions", () => {
    // Source: lend USDC / borrow WETH, Target: lend WETH / borrow USDC
    const source = mkFlat(ETH_USDC, ETH_WETH);
    const target = mkFlat(BASE_WETH, BASE_USDC);

    const mode = flowTestables.inferRescueModeFromPositions(source as never, target as never, mapping);
    expect(mode).toBe("REPAY");
  });
});

