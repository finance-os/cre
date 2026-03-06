import { describe, expect, test } from "bun:test";
import { __testables } from "./risk-v1";

describe("risk-v1 integrity", () => {
  test("accepts matching integrity hash", () => {
    const asset = "0x1111111111111111111111111111111111111111";
    const priceUsd = "2000";
    const updatedAt = 1772461447;
    const salt = "reprieve-chainlink-api-guard-v1";
    const hash = __testables.buildIntegrityHash(asset, priceUsd, updatedAt, salt);

    const ok = __testables.verifyReportIntegrity(
      {
        asset,
        priceUsd,
        updatedAt,
        integrityHash: hash,
        source: "api",
      },
      salt
    );

    expect(ok).toBeTrue();
  });

  test("rejects mismatched integrity hash", () => {
    const ok = __testables.verifyReportIntegrity(
      {
        asset: "0x1111111111111111111111111111111111111111",
        priceUsd: "2000",
        updatedAt: 1772461447,
        integrityHash:
          "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        source: "api",
      },
      "reprieve-chainlink-api-guard-v1"
    );

    expect(ok).toBeFalse();
  });
});

describe("risk-v1 slope sensitivity", () => {
  test("zero slope when no previous price", () => {
    expect(
      __testables.computeShockBps({
        asset: "0x1111111111111111111111111111111111111111",
        priceUsd: "2000",
        updatedAt: 1772461447,
        source: "api",
      })
    ).toBe(0);
  });

  test("higher move yields higher bps shock", () => {
    const mild = __testables.computeShockBps({
      asset: "0x1111111111111111111111111111111111111111",
      priceUsd: "1900",
      prevPriceUsd: "2000",
      updatedAt: 1772461447,
      source: "api",
    });

    const sharp = __testables.computeShockBps({
      asset: "0x1111111111111111111111111111111111111111",
      priceUsd: "1500",
      prevPriceUsd: "2000",
      updatedAt: 1772461447,
      source: "api",
    });

    expect(mild).toBeGreaterThan(0);
    expect(sharp).toBeGreaterThan(mild);
  });
});
