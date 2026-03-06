import {
  LATEST_BLOCK_NUMBER,
  bytesToHex,
  cre,
  encodeCallMsg,
  getNetwork,
  hexToBase64,
  type Runtime,
} from "@chainlink/cre-sdk";
import {
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseAbi,
  parseAbiParameters,
  toBytes,
  type Address,
  type Hex,
  zeroAddress,
} from "viem";
import type { TokenTypeLabel, WorkflowConfig } from "./types";

const VAULT_ABI = parseAbi([
  "function getPayment(uint256 paymentId) view returns ((address sender,address[] recipients,uint256[] amounts,uint8 tokenType,address tokenAddress,uint8 status,uint8 auditMask,uint256 createdAt))",
  "function getComplianceHash(uint256 paymentId) view returns (bytes32)",
  "function complianceHashes(uint256 paymentId) view returns (bytes32)",
]);

const IDENTITY_REGISTRY_ABI = parseAbi([
  "function getIdentity(address wallet) view returns (bytes32)",
]);

const CREDENTIAL_REGISTRY_ABI = parseAbi([
  "function validate(bytes32 identity, bytes32 credentialTypeId) view returns (bool)",
]);

const ZERO_BYTES32 =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;

const ACTION_RELEASE = 0;
const ACTION_FREEZE = 1;
const ACTION_REFUND = 2;
const ACTION_ANCHOR = 3;

const VAULT_REPORT_DATA_PARAMS = parseAbiParameters("(uint8,uint256,bytes32,uint8)");

export const CREDENTIAL_TYPE_KYC = keccak256(toBytes("KYC"));
export const CREDENTIAL_TYPE_AML = keccak256(toBytes("AML"));
export const CREDENTIAL_TYPE_SANCTIONS = keccak256(toBytes("SANCTIONS"));
export const CREDENTIAL_TYPE_WORLD_ID = keccak256(toBytes("WORLD_ID"));

export interface PaymentSnapshot {
  sender: Address;
  recipients: Address[];
  amounts: bigint[];
  tokenType: number;
  tokenAddress: Address;
  status: number;
  auditMask: number;
  createdAt: bigint;
}

const createEvmClient = (config: WorkflowConfig) => {
  const network = getNetwork({
    chainFamily: "evm",
    chainSelectorName: config.chainSelectorName,
    isTestnet: config.isTestnet,
  });
  if (!network) {
    throw new Error(`Unable to resolve network for ${config.chainSelectorName}`);
  }
  return new cre.capabilities.EVMClient(network.chainSelector.selector);
};

const readContract = <T>(
  runtime: Runtime<WorkflowConfig>,
  config: WorkflowConfig,
  contractAddress: Address,
  abi: ReturnType<typeof parseAbi>,
  functionName: string,
  args: unknown[] = []
): T => {
  const evmClient = createEvmClient(config);
  const calldata = encodeFunctionData({
    abi,
    functionName,
    args,
  });
  const response = evmClient
    .callContract(runtime, {
      call: encodeCallMsg({
        from: zeroAddress,
        to: contractAddress,
        data: calldata,
      }),
      blockNumber: LATEST_BLOCK_NUMBER,
    })
    .result();

  return decodeFunctionResult({
    abi,
    functionName,
    data: bytesToHex(response.data),
  }) as T;
};

const encodeVaultReportPayload = (
  action: number,
  paymentId: bigint,
  resultHash: Hex,
  finalDecision: number
): Hex =>
  encodeAbiParameters(VAULT_REPORT_DATA_PARAMS, [
    [action, paymentId, resultHash, finalDecision] as const,
  ]);

const writeVaultReport = (
  runtime: Runtime<WorkflowConfig>,
  config: WorkflowConfig,
  action: number,
  paymentId: bigint,
  resultHash: Hex,
  finalDecision: number,
  gasLimit: string
): Hex => {
  const evmClient = createEvmClient(config);
  const reportPayload = encodeVaultReportPayload(
    action,
    paymentId,
    resultHash,
    finalDecision
  );

  const reportResponse = runtime
    .report({
      encodedPayload: hexToBase64(reportPayload),
      encoderName: "evm",
      signingAlgo: "ecdsa",
      hashingAlgo: "keccak256",
    })
    .result();

  const writeResult = evmClient
    .writeReport(runtime, {
      receiver: config.contracts.vault,
      report: reportResponse,
      gasConfig: {
        gasLimit,
      },
    })
    .result();

  return bytesToHex(writeResult.txHash ?? new Uint8Array(32)) as Hex;
};

export const tokenTypeToLabel = (value: number): TokenTypeLabel =>
  value === 0 ? "ETH" : "ERC20";

export const readPayment = (
  runtime: Runtime<WorkflowConfig>,
  config: WorkflowConfig,
  paymentId: bigint
): PaymentSnapshot => {
  const raw = readContract<any>(
    runtime,
    config,
    config.contracts.vault,
    VAULT_ABI,
    "getPayment",
    [paymentId]
  );

  return {
    sender: (raw.sender ?? raw[0]) as Address,
    recipients: (raw.recipients ?? raw[1]) as Address[],
    amounts: (raw.amounts ?? raw[2]) as bigint[],
    tokenType: Number(raw.tokenType ?? raw[3]),
    tokenAddress: (raw.tokenAddress ?? raw[4]) as Address,
    status: Number(raw.status ?? raw[5]),
    auditMask: Number(raw.auditMask ?? raw[6]),
    createdAt: (raw.createdAt ?? raw[7]) as bigint,
  };
};

export const readComplianceHash = (
  runtime: Runtime<WorkflowConfig>,
  config: WorkflowConfig,
  paymentId: bigint
): Hex =>
  readContract<Hex>(
    runtime,
    config,
    config.contracts.vault,
    VAULT_ABI,
    "complianceHashes",
    [paymentId]
  );

export const readCCID = (
  runtime: Runtime<WorkflowConfig>,
  config: WorkflowConfig,
  wallet: Address
): Hex =>
  readContract<Hex>(
    runtime,
    config,
    config.contracts.identityRegistry,
    IDENTITY_REGISTRY_ABI,
    "getIdentity",
    [wallet]
  );

const readCredentialValidation = (
  runtime: Runtime<WorkflowConfig>,
  config: WorkflowConfig,
  registry: Address,
  ccid: Hex,
  credentialTypeId: Hex
): boolean =>
  readContract<boolean>(
    runtime,
    config,
    registry,
    CREDENTIAL_REGISTRY_ABI,
    "validate",
    [ccid, credentialTypeId]
  );

export const readKycCredential = (
  runtime: Runtime<WorkflowConfig>,
  config: WorkflowConfig,
  ccid: Hex
): boolean =>
  readCredentialValidation(
    runtime,
    config,
    config.contracts.kycRegistry,
    ccid,
    CREDENTIAL_TYPE_KYC
  );

export const readAmlCredential = (
  runtime: Runtime<WorkflowConfig>,
  config: WorkflowConfig,
  ccid: Hex
): boolean =>
  readCredentialValidation(
    runtime,
    config,
    config.contracts.amlRegistry,
    ccid,
    CREDENTIAL_TYPE_AML
  );

export const readSanctionsCredential = (
  runtime: Runtime<WorkflowConfig>,
  config: WorkflowConfig,
  ccid: Hex
): boolean =>
  readCredentialValidation(
    runtime,
    config,
    config.contracts.sanctionRegistry,
    ccid,
    CREDENTIAL_TYPE_SANCTIONS
  );

export const readWorldIdCredential = (
  runtime: Runtime<WorkflowConfig>,
  config: WorkflowConfig,
  ccid: Hex
): boolean =>
  readCredentialValidation(
    runtime,
    config,
    config.contracts.worldidRegistry,
    ccid,
    CREDENTIAL_TYPE_WORLD_ID
  );

export const writeAnchorCompliance = (
  runtime: Runtime<WorkflowConfig>,
  config: WorkflowConfig,
  paymentId: bigint,
  resultHash: Hex,
  finalDecisionCode: 1 | 2
): Hex =>
  writeVaultReport(
    runtime,
    config,
    ACTION_ANCHOR,
    paymentId,
    resultHash,
    finalDecisionCode,
    "900000"
  );

export const writeReleasePayment = (
  runtime: Runtime<WorkflowConfig>,
  config: WorkflowConfig,
  paymentId: bigint
): Hex =>
  writeVaultReport(
    runtime,
    config,
    ACTION_RELEASE,
    paymentId,
    ZERO_BYTES32,
    0,
    "2200000"
  );

export const writeFreezePayment = (
  runtime: Runtime<WorkflowConfig>,
  config: WorkflowConfig,
  paymentId: bigint
): Hex =>
  writeVaultReport(
    runtime,
    config,
    ACTION_FREEZE,
    paymentId,
    ZERO_BYTES32,
    0,
    "500000"
  );

export const writeRefundPayment = (
  runtime: Runtime<WorkflowConfig>,
  config: WorkflowConfig,
  paymentId: bigint
): Hex =>
  writeVaultReport(
    runtime,
    config,
    ACTION_REFUND,
    paymentId,
    ZERO_BYTES32,
    0,
    "800000"
  );
