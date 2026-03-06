import {
  HTTPClient,
  bytesToHex,
  consensusIdenticalAggregation,
  ok,
  text,
  type EVMLog,
  type NodeRuntime,
  type Runtime,
} from "@chainlink/cre-sdk";
import {
  decodeEventLog,
  encodePacked,
  formatEther,
  keccak256,
  parseAbi,
  toBytes,
  type Address,
  type Hex,
} from "viem";
import {
  readAmlCredential,
  readComplianceHash,
  readKycCredential,
  readPayment,
  readSanctionsCredential,
  readWorldIdCredential,
  tokenTypeToLabel,
  writeAnchorCompliance,
  writeReleasePayment,
  type PaymentSnapshot,
} from "./contracts";
import type {
  ComplianceCheck,
  FinalDecision,
  RecipientCompliance,
  SenderCompliance,
  TokenTypeLabel,
  WorkflowConfig,
} from "./types";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_TX_HASH =
  "0x0000000000000000000000000000000000000000000000000000000000000000";
const AUDIT_BIT_KYC = 1;
const AUDIT_BIT_AML = 2;
const AUDIT_BIT_SANCTIONS = 4;
const AUDIT_BIT_WORLD_ID = 8;
const STATUS_PENDING = 0;

const DEPOSIT_CREATED_ABI = parseAbi([
  "event DepositCreated(uint256 indexed paymentId,address indexed sender,uint256 totalAmount,uint256 recipientCount,uint8 tokenType,address tokenAddress,uint8 auditMask)",
]);

interface DepositEventContext {
  paymentId: bigint;
  sender: Address;
  totalAmountWei: bigint;
  recipientCount: number;
  tokenType: TokenTypeLabel;
  tokenAddress: Address;
  auditMask: number;
  txHash: Hex;
  txIndex: number;
  logIndex: number;
  blockNumber?: bigint;
  removed: boolean;
}

interface BackendPayload {
  paymentId: string;
  auditResult: {
    paymentId: number;
    timestamp: number;
    auditMask: number;
    sender: {
      address: string;
      checks: SenderCompliance["checks"];
      overallResult: "PASS" | "FAIL";
    };
    recipients: Array<{
      address: string;
      amount: string;
      amountWei: string;
      checks: RecipientCompliance["checks"];
      result: "PASS" | "FAIL";
    }>;
    finalDecision: "PASS" | "BLOCK";
    blockReason?: string;
  };
  finalDecision: "PASS" | "BLOCK";
  blockReason?: string;
}

interface FlowResponse {
  strategyId: string;
  workflowVersion: string;
  trigger: "evm_log";
  runMode: "execute" | "dry_run";
  decision: FinalDecision | "ABORT";
  reason: string;
  paymentId?: string;
  complianceHash?: string;
  txRefs: {
    sourceDepositTx?: string;
    anchorTx?: string;
    settlementTx?: string;
  };
  verification: {
    onChainMatch: boolean;
    mismatches: string[];
    anchorVerified?: boolean;
  };
  auditResult?: {
    paymentId: string;
    timestamp: number;
    auditMask: number;
    sender: {
      address: string;
      checks: SenderCompliance["checks"];
      overallResult: "PASS" | "FAIL";
    };
    recipients: Array<{
      address: string;
      amount: string;
      amountWei: string;
      checks: RecipientCompliance["checks"];
      result: "PASS" | "FAIL";
    }>;
    finalDecision: FinalDecision;
    blockReason?: string;
  };
  backendPayload?: BackendPayload;
  metadata: Record<string, string | number | boolean>;
}

interface IdentityResolution {
  ccid: Hex;
  error?: string;
}

interface BackendDispatchResult {
  dispatch: "sent" | "failed" | "skipped_dry_run" | "disabled";
  statusCode?: number;
  error?: string;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const dispatchBackendPayload = (
  runtime: Runtime<WorkflowConfig>,
  config: WorkflowConfig,
  payload: BackendPayload
): BackendDispatchResult => {
  if (!config.backend?.enabled) {
    return { dispatch: "disabled" };
  }
  if (config.execution.runMode === "dry_run") {
    return { dispatch: "skipped_dry_run" };
  }

  try {
    const body = JSON.stringify(payload);
    const response = runtime.runInNodeMode(
      (
        nodeRuntime: NodeRuntime<WorkflowConfig>,
        url: string,
        rawBody: string
      ): { success: boolean; statusCode: number; responseBody: string } => {
        const client = new HTTPClient();
        const httpResponse = client
          .sendRequest(nodeRuntime, {
            url,
            method: "POST",
            headers: {
              "content-type": "application/json",
            },
            body: Buffer.from(rawBody, "utf8").toString("base64"),
          })
          .result();

        return {
          success: ok(httpResponse),
          statusCode: httpResponse.statusCode,
          responseBody: text(httpResponse),
        };
      },
      consensusIdenticalAggregation<{
        success: boolean;
        statusCode: number;
        responseBody: string;
      }>()
    )(config.backend.url, body).result();

    if (!response.success) {
      return {
        dispatch: "failed",
        statusCode: response.statusCode,
        error: `HTTP_${response.statusCode}${response.responseBody ? `: ${response.responseBody}` : ""}`,
      };
    }
    return {
      dispatch: "sent",
      statusCode: response.statusCode,
    };
  } catch (error) {
    return {
      dispatch: "failed",
      error: errorMessage(error),
    };
  }
};

const checkEnabled = (auditMask: number, bit: number): boolean =>
  (auditMask & bit) !== 0;

const sum = (values: bigint[]): bigint =>
  values.reduce((acc, current) => acc + current, 0n);

const parseProtoBigInt = (value: EVMLog["blockNumber"]): bigint | undefined => {
  if (!value) return undefined;
  let abs = 0n;
  for (const byte of value.absVal) {
    abs = (abs << 8n) + BigInt(byte);
  }
  return value.sign < 0n ? -abs : abs;
};

const parseDepositEvent = (payload: EVMLog): DepositEventContext => {
  const topics = payload.topics.map((entry) => bytesToHex(entry)) as [Hex, ...Hex[]];
  const data = bytesToHex(payload.data);
  const decoded = decodeEventLog({
    abi: DEPOSIT_CREATED_ABI,
    topics,
    data,
  });

  if (decoded.eventName !== "DepositCreated") {
    throw new Error(`Unsupported event: ${decoded.eventName}`);
  }

  const args = decoded.args as unknown as {
    paymentId: bigint;
    sender: Address;
    totalAmount: bigint;
    recipientCount: bigint;
    tokenType: bigint;
    tokenAddress: Address;
    auditMask: bigint;
  };

  return {
    paymentId: args.paymentId,
    sender: args.sender,
    totalAmountWei: args.totalAmount,
    recipientCount: Number(args.recipientCount),
    tokenType: tokenTypeToLabel(Number(args.tokenType)),
    tokenAddress: args.tokenAddress,
    auditMask: Number(args.auditMask),
    txHash: bytesToHex(payload.txHash) as Hex,
    txIndex: payload.txIndex,
    logIndex: payload.index,
    blockNumber: parseProtoBigInt(payload.blockNumber),
    removed: payload.removed,
  };
};

const deriveCCID = (wallet: Address): Hex =>
  keccak256(toBytes(`ccid:${wallet.toLowerCase()}`));

const resolveIdentity = (
  wallet: Address
): IdentityResolution => {
  return { ccid: deriveCCID(wallet) };
};

const evaluateCredentialCheck = (
  enabled: boolean,
  identity: IdentityResolution,
  fn: (ccid: Hex) => boolean,
  failReason: string
): ComplianceCheck => {
  if (!enabled) return { checked: false, passed: null };
  if (identity.error) {
    return {
      checked: true,
      passed: false,
      reason: "CHECK_ERROR",
    };
  }

  try {
    const passed = fn(identity.ccid);
    return {
      checked: true,
      passed,
      reason: passed ? undefined : failReason,
    };
  } catch {
    return {
      checked: true,
      passed: false,
      reason: "CHECK_ERROR",
    };
  }
};

const evaluateSenderCompliance = (
  runtime: Runtime<WorkflowConfig>,
  config: WorkflowConfig,
  sender: Address,
  auditMask: number,
  identity: IdentityResolution
): SenderCompliance => {
  const kyc = evaluateCredentialCheck(
    checkEnabled(auditMask, AUDIT_BIT_KYC),
    identity,
    (ccid) => readKycCredential(runtime, config, ccid),
    "SENDER_KYC_FAIL"
  );
  const aml = evaluateCredentialCheck(
    checkEnabled(auditMask, AUDIT_BIT_AML),
    identity,
    (ccid) => readAmlCredential(runtime, config, ccid),
    "SENDER_AML_FAIL"
  );
  const sanctions = evaluateCredentialCheck(
    checkEnabled(auditMask, AUDIT_BIT_SANCTIONS),
    identity,
    (ccid) => readSanctionsCredential(runtime, config, ccid),
    "SENDER_SANCTIONS_FAIL"
  );
  const worldId = evaluateCredentialCheck(
    checkEnabled(auditMask, AUDIT_BIT_WORLD_ID),
    identity,
    (ccid) => readWorldIdCredential(runtime, config, ccid),
    "SENDER_WORLDID_FAIL"
  );

  const overallResult =
    [kyc, aml, sanctions, worldId].every(
      (entry) => !entry.checked || entry.passed === true
    )
      ? "PASS"
      : "FAIL";

  return {
    address: sender,
    checks: { kyc, aml, sanctions, worldId },
    overallResult,
  };
};

const evaluateRecipientCompliance = (
  runtime: Runtime<WorkflowConfig>,
  config: WorkflowConfig,
  auditMask: number,
  recipient: Address,
  amountWei: bigint,
  identity: IdentityResolution
): RecipientCompliance => {
  const kyc = evaluateCredentialCheck(
    checkEnabled(auditMask, AUDIT_BIT_KYC),
    identity,
    (ccid) => readKycCredential(runtime, config, ccid),
    "RECIPIENT_KYC_FAIL"
  );
  const aml = evaluateCredentialCheck(
    checkEnabled(auditMask, AUDIT_BIT_AML),
    identity,
    (ccid) => readAmlCredential(runtime, config, ccid),
    "RECIPIENT_AML_FAIL"
  );
  const sanctions = evaluateCredentialCheck(
    checkEnabled(auditMask, AUDIT_BIT_SANCTIONS),
    identity,
    (ccid) => readSanctionsCredential(runtime, config, ccid),
    "RECIPIENT_SANCTIONS_FAIL"
  );

  const result =
    [kyc, aml, sanctions].every(
      (entry) => !entry.checked || entry.passed === true
    )
      ? "PASS"
      : "FAIL";

  return {
    address: recipient,
    amountWei,
    checks: { kyc, aml, sanctions },
    result,
  };
};

const buildBlockReason = (
  sender: SenderCompliance,
  recipients: RecipientCompliance[]
): string | undefined => {
  const mapSenderCheckFailure = (
    check: ComplianceCheck,
    failCode: string
  ): string | undefined => {
    if (!check.checked || check.passed !== false) return undefined;
    if (check.reason === "CHECK_ERROR") return "SENDER_CHECK_ERROR";
    return failCode;
  };

  const mapRecipientCheckFailure = (
    check: ComplianceCheck,
    failCode: string
  ): string | undefined => {
    if (!check.checked || check.passed !== false) return undefined;
    if (check.reason === "CHECK_ERROR") return "RECIPIENT_CHECK_ERROR";
    return failCode;
  };

  if (sender.overallResult === "FAIL") {
    const senderKyc = mapSenderCheckFailure(sender.checks.kyc, "SENDER_KYC_FAIL");
    if (senderKyc) return senderKyc;
    const senderAml = mapSenderCheckFailure(sender.checks.aml, "SENDER_AML_FAIL");
    if (senderAml) return senderAml;
    const senderSanctions = mapSenderCheckFailure(
      sender.checks.sanctions,
      "SENDER_SANCTIONS_FAIL"
    );
    if (senderSanctions) return senderSanctions;
    const senderWorldId = mapSenderCheckFailure(
      sender.checks.worldId,
      "SENDER_WORLDID_FAIL"
    );
    if (senderWorldId) return senderWorldId;
    return "SENDER_COMPLIANCE_FAIL";
  }

  const failedRecipient = recipients.find((entry) => entry.result === "FAIL");
  if (!failedRecipient) return undefined;

  const recipientKyc = mapRecipientCheckFailure(
    failedRecipient.checks.kyc,
    "RECIPIENT_KYC_FAIL"
  );
  if (recipientKyc) return recipientKyc;
  const recipientAml = mapRecipientCheckFailure(
    failedRecipient.checks.aml,
    "RECIPIENT_AML_FAIL"
  );
  if (recipientAml) return recipientAml;
  const recipientSanctions = mapRecipientCheckFailure(
    failedRecipient.checks.sanctions,
    "RECIPIENT_SANCTIONS_FAIL"
  );
  if (recipientSanctions) return recipientSanctions;
  return "RECIPIENT_COMPLIANCE_FAIL";
};

const verifyEventAgainstOnchain = (
  event: DepositEventContext,
  payment: PaymentSnapshot
): string[] => {
  const mismatches: string[] = [];

  if (payment.sender.toLowerCase() === ZERO_ADDRESS) {
    mismatches.push("payment not found");
    return mismatches;
  }
  if (payment.status !== STATUS_PENDING) {
    mismatches.push(`payment status is ${payment.status}, expected PENDING(0)`);
  }
  if (payment.sender.toLowerCase() !== event.sender.toLowerCase()) {
    mismatches.push("sender mismatch");
  }
  if (payment.auditMask !== event.auditMask) {
    mismatches.push(
      `auditMask mismatch on-chain=${payment.auditMask} event=${event.auditMask}`
    );
  }

  const paymentTokenType = tokenTypeToLabel(payment.tokenType);
  if (paymentTokenType !== event.tokenType) {
    mismatches.push(
      `tokenType mismatch on-chain=${paymentTokenType} event=${event.tokenType}`
    );
  }
  if (payment.tokenAddress.toLowerCase() !== event.tokenAddress.toLowerCase()) {
    mismatches.push("tokenAddress mismatch");
  }
  if (payment.recipients.length !== event.recipientCount) {
    mismatches.push(
      `recipientCount mismatch on-chain=${payment.recipients.length} event=${event.recipientCount}`
    );
  }

  const onchainTotal = sum(payment.amounts);
  if (onchainTotal !== event.totalAmountWei) {
    mismatches.push(
      `totalAmount mismatch on-chain=${onchainTotal.toString()} event=${event.totalAmountWei.toString()}`
    );
  }

  return mismatches;
};

const computeComplianceHash = (
  paymentId: bigint,
  sender: Address,
  auditMask: number,
  senderChecks: SenderCompliance["checks"],
  recipients: RecipientCompliance[],
  decision: FinalDecision,
  timestamp: number
): Hex => {
  const recipientData = recipients.map((entry) =>
    encodePacked(
      ["address", "bool", "bool", "bool", "uint256"],
      [
        entry.address,
        entry.checks.kyc.passed === true,
        entry.checks.aml.passed === true,
        entry.checks.sanctions.passed === true,
        entry.amountWei,
      ]
    )
  );

  const recipientsHash = keccak256(encodePacked(["bytes[]"], [recipientData]));

  return keccak256(
    encodePacked(
      [
        "uint256",
        "address",
        "bool",
        "bool",
        "bool",
        "bytes32",
        "uint8",
        "bool",
        "uint256",
      ],
      [
        paymentId,
        sender,
        senderChecks.kyc.passed === true,
        senderChecks.aml.passed === true,
        senderChecks.sanctions.passed === true,
        recipientsHash,
        auditMask,
        decision === "RELEASED",
        BigInt(timestamp),
      ]
    )
  );
};

const responseBase = (
  config: WorkflowConfig
): Omit<FlowResponse, "decision" | "reason" | "txRefs" | "verification" | "metadata"> => ({
  strategyId: config.strategyId,
  workflowVersion: config.workflowVersion,
  trigger: "evm_log",
  runMode: config.execution.runMode,
});

export const runComplianceVaultFlow = (
  runtime: Runtime<WorkflowConfig>,
  config: WorkflowConfig,
  payload: EVMLog
): FlowResponse => {
  const response = responseBase(config);
  let onChainMatched = false;

  let event: DepositEventContext;
  try {
    event = parseDepositEvent(payload);
  } catch (error) {
    return {
      ...response,
      decision: "ABORT",
      reason: `INVALID_DEPOSIT_LOG: ${errorMessage(error)}`,
      txRefs: {},
      verification: { onChainMatch: false, mismatches: [] },
      metadata: {},
    };
  }

  const txRefs: FlowResponse["txRefs"] = {
    sourceDepositTx: event.txHash,
  };

  if (event.removed) {
    return {
      ...response,
      decision: "ABORT",
      reason: "LOG_REMOVED_REORG",
      paymentId: event.paymentId.toString(),
      txRefs,
      verification: { onChainMatch: false, mismatches: [] },
      metadata: {
        txIndex: event.txIndex,
        logIndex: event.logIndex,
      },
    };
  }

  runtime.log(
    `Processing DepositCreated paymentId=${event.paymentId.toString()} runMode=${config.execution.runMode}`
  );
  runtime.log(
    `Decoded log paymentId=${event.paymentId.toString()} sender=${event.sender} tokenType=${event.tokenType} tokenAddress=${event.tokenAddress} totalAmountWei=${event.totalAmountWei.toString()} recipientCount=${event.recipientCount} auditMask=${event.auditMask} txHash=${event.txHash} blockNumber=${event.blockNumber?.toString() ?? "unknown"} txIndex=${event.txIndex} logIndex=${event.logIndex}`
  );

  try {
    const payment = readPayment(runtime, config, event.paymentId);
    const paymentTokenType = tokenTypeToLabel(payment.tokenType);
    const paymentTotalAmountWei = sum(payment.amounts);

    runtime.log(
      `Read payment paymentId=${event.paymentId.toString()} sender=${payment.sender} tokenType=${paymentTokenType} tokenAddress=${payment.tokenAddress} status=${payment.status} auditMask=${payment.auditMask} recipientCount=${payment.recipients.length} totalAmountWei=${paymentTotalAmountWei.toString()}`
    );
    const recipientsLog = payment.recipients
      .map((recipient, index) => `${recipient}:${payment.amounts[index].toString()}`)
      .join(", ");
    runtime.log(`Read recipients amountsWei=[${recipientsLog}]`);

    const mismatches = verifyEventAgainstOnchain(event, payment);
    if (mismatches.length > 0) {
      return {
        ...response,
        decision: "ABORT",
        reason: "EVENT_ONCHAIN_MISMATCH",
        paymentId: event.paymentId.toString(),
        txRefs,
        verification: {
          onChainMatch: false,
          mismatches,
        },
        metadata: {
          txIndex: event.txIndex,
          logIndex: event.logIndex,
          blockNumber: event.blockNumber?.toString() ?? "unknown",
        },
      };
    }
    onChainMatched = true;

    const senderIdentity = resolveIdentity(payment.sender);
    runtime.log(
      `Sender identity sender=${payment.sender} ccid=${senderIdentity.ccid} source=deterministic`
    );

    const recipientIdentities = payment.recipients.map((recipient) =>
      resolveIdentity(recipient)
    );
    payment.recipients.forEach((recipient, index) => {
      const identity = recipientIdentities[index];
      runtime.log(
        `Recipient identity recipient=${recipient} ccid=${identity.ccid} source=deterministic`
      );
    });

    const senderCompliance = evaluateSenderCompliance(
      runtime,
      config,
      payment.sender,
      payment.auditMask,
      senderIdentity
    );
    const recipientCompliances = payment.recipients.map((recipient, index) =>
      evaluateRecipientCompliance(
        runtime,
        config,
        payment.auditMask,
        recipient,
        payment.amounts[index],
        recipientIdentities[index]
      )
    );
    const senderFailed = senderCompliance.overallResult === "FAIL";
    const anyRecipientFailed = recipientCompliances.some((entry) => entry.result === "FAIL");
    const finalDecision: FinalDecision =
      !senderFailed && !anyRecipientFailed ? "RELEASED" : "FROZEN";
    const blockReason = buildBlockReason(senderCompliance, recipientCompliances);
    const evaluatedAt = Math.floor(Date.now() / 1000);

    const complianceHash = computeComplianceHash(
      event.paymentId,
      payment.sender,
      payment.auditMask,
      senderCompliance.checks,
      recipientCompliances,
      finalDecision,
      evaluatedAt
    );

    const auditResult: FlowResponse["auditResult"] = {
      paymentId: event.paymentId.toString(),
      timestamp: evaluatedAt,
      auditMask: payment.auditMask,
      sender: {
        address: senderCompliance.address,
        checks: senderCompliance.checks,
        overallResult: senderCompliance.overallResult,
      },
      recipients: recipientCompliances.map((entry) => ({
        address: entry.address,
        amount: formatEther(entry.amountWei),
        amountWei: entry.amountWei.toString(),
        checks: entry.checks,
        result: entry.result,
      })),
      finalDecision,
      blockReason,
    };

    const backendDecision = finalDecision === "RELEASED" ? "PASS" : "BLOCK";
    const backendPayload: BackendPayload = {
      paymentId: event.paymentId.toString(),
      auditResult: {
        paymentId: Number(event.paymentId),
        timestamp: evaluatedAt,
        auditMask: payment.auditMask,
        sender: {
          address: senderCompliance.address,
          checks: senderCompliance.checks,
          overallResult: senderCompliance.overallResult,
        },
        recipients: auditResult.recipients,
        finalDecision: backendDecision,
        blockReason,
      },
      finalDecision: backendDecision,
      blockReason,
    };
    const backendDispatchResult = dispatchBackendPayload(runtime, config, backendPayload);
    if (backendDispatchResult.dispatch === "sent") {
      runtime.log(
        `Backend dispatch succeeded status=${backendDispatchResult.statusCode ?? "unknown"}`
      );
    } else if (backendDispatchResult.dispatch === "failed") {
      runtime.log(
        `Backend dispatch failed status=${backendDispatchResult.statusCode ?? "unknown"} error=${backendDispatchResult.error ?? "unknown"}`
      );
    }
    const backendDispatchMeta: Record<string, string | number | boolean> = {
      backendDispatch: backendDispatchResult.dispatch,
    };
    if (backendDispatchResult.statusCode !== undefined) {
      backendDispatchMeta.backendStatusCode = backendDispatchResult.statusCode;
    }
    if (backendDispatchResult.error) {
      backendDispatchMeta.backendDispatchError = backendDispatchResult.error;
    }

    if (config.execution.runMode === "dry_run") {
      return {
        ...response,
        decision: finalDecision,
        reason: "DRY_RUN",
        paymentId: event.paymentId.toString(),
        complianceHash,
        txRefs,
        verification: {
          onChainMatch: true,
          mismatches: [],
        },
        auditResult,
        backendPayload,
        metadata: {
          txIndex: event.txIndex,
          logIndex: event.logIndex,
          blockNumber: event.blockNumber?.toString() ?? "unknown",
          paymentSource: "evm_read",
          anchored: false,
          settled: false,
          ...backendDispatchMeta,
        },
      };
    }

    const finalDecisionCode = finalDecision === "RELEASED" ? 1 : 2;
    txRefs.anchorTx = writeAnchorCompliance(
      runtime,
      config,
      event.paymentId,
      complianceHash,
      finalDecisionCode
    );

    const anchorSubmitted = txRefs.anchorTx !== ZERO_TX_HASH;
    const shouldVerifyAnchor = anchorSubmitted;
    let anchorVerified = false;
    if (shouldVerifyAnchor) {
      const onchainHash = readComplianceHash(runtime, config, event.paymentId);
      anchorVerified = onchainHash.toLowerCase() === complianceHash.toLowerCase();
      if (!anchorVerified) {
        return {
          ...response,
          decision: "ABORT",
          reason: "ANCHOR_HASH_MISMATCH",
          paymentId: event.paymentId.toString(),
          complianceHash,
          txRefs,
          verification: {
            onChainMatch: true,
            mismatches: [],
            anchorVerified: false,
          },
          auditResult,
          backendPayload,
          metadata: {
            txIndex: event.txIndex,
            logIndex: event.logIndex,
            blockNumber: event.blockNumber?.toString() ?? "unknown",
            paymentSource: "evm_read",
            anchored: anchorSubmitted,
            settled: false,
            ...backendDispatchMeta,
          },
        };
      }
    }

    let settlementSubmitted = false;
    if (finalDecision === "RELEASED") {
      txRefs.settlementTx = writeReleasePayment(runtime, config, event.paymentId);
      settlementSubmitted = txRefs.settlementTx !== ZERO_TX_HASH;
    }

    return {
      ...response,
      decision: finalDecision,
      reason:
        finalDecision === "RELEASED"
          ? "ALL_CHECKS_PASS"
          : blockReason ?? "COMPLIANCE_FAIL",
      paymentId: event.paymentId.toString(),
      complianceHash,
      txRefs,
      verification: {
        onChainMatch: true,
        mismatches: [],
        anchorVerified: shouldVerifyAnchor ? anchorVerified : undefined,
      },
      auditResult,
      backendPayload,
      metadata: {
        txIndex: event.txIndex,
        logIndex: event.logIndex,
        blockNumber: event.blockNumber?.toString() ?? "unknown",
        paymentSource: "evm_read",
        anchored: anchorSubmitted,
        settled: finalDecision === "RELEASED" ? settlementSubmitted : false,
        ...backendDispatchMeta,
      },
    };
  } catch (error) {
    return {
      ...response,
      decision: "ABORT",
      reason: `EXECUTION_ERROR: ${errorMessage(error)}`,
      paymentId: event.paymentId.toString(),
      txRefs,
      verification: {
        onChainMatch: onChainMatched,
        mismatches: [],
      },
      metadata: {
        txIndex: event.txIndex,
        logIndex: event.logIndex,
        blockNumber: event.blockNumber?.toString() ?? "unknown",
        paymentSource: "evm_read",
      },
    };
  }
};
