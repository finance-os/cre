import { cre, getNetwork, type EVMLog, type Runtime } from "@chainlink/cre-sdk";
import type { WorkflowConfig } from "./types";

const toHexTopic = (topic: string): string => {
  const normalized = topic.toLowerCase();
  if (!normalized.startsWith("0x")) {
    throw new Error(`Invalid topic "${topic}": expected 0x-prefixed hex`);
  }
  return normalized;
};

export const safeJson = (value: unknown): string =>
  JSON.stringify(value, (_key, entry) => {
    if (typeof entry === "bigint") {
      return entry.toString();
    }
    return entry;
  });

export const registerEvmLogTrigger = (
  config: WorkflowConfig,
  handler: (runtime: Runtime<WorkflowConfig>, payload: EVMLog) => string
) => {
  if (!config.trigger.evmLog.enabled) {
    throw new Error("EVM log trigger is disabled in config");
  }
  const network = getNetwork({
    chainFamily: "evm",
    chainSelectorName: config.trigger.evmLog.chainSelectorName,
    isTestnet: config.trigger.evmLog.isTestnet,
  });
  if (!network) {
    throw new Error(
      `Unable to resolve network for ${config.trigger.evmLog.chainSelectorName}`
    );
  }
  const evmClient = new cre.capabilities.EVMClient(network.chainSelector.selector);
  const logTrigger = evmClient.logTrigger({
    addresses: config.trigger.evmLog.addresses,
    topics: [{ values: config.trigger.evmLog.topics.map(toHexTopic) }],
    confidence: config.trigger.evmLog.confidence,
  });
  return [cre.handler(logTrigger, handler as any)];
};
