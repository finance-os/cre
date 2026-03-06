import {
  cre,
  type Runtime,
  type CronPayload,
  type EVMLog,
  getNetwork,
} from "@chainlink/cre-sdk";
import type { BaseWorkflowConfig, ExecutionEnvelope } from "./types";

export interface BaseHandlers<TConfig extends BaseWorkflowConfig> {
  onHttp: (runtime: Runtime<TConfig>, payload: unknown) => string;
  onEvmLog: (runtime: Runtime<TConfig>, payload: EVMLog) => string;
  onCron: (runtime: Runtime<TConfig>, payload: CronPayload) => string;
}

const textDecoder = new TextDecoder();

const toHexTopic = (topic: string): string => {
  const normalized = topic.toLowerCase();
  if (!normalized.startsWith("0x")) {
    throw new Error(`Invalid topic "${topic}": expected 0x-prefixed hex`);
  }
  return normalized;
};

export const resolveCronTimestampSeconds = (payload: CronPayload): number => {
  if (payload.scheduledExecutionTime?.seconds) {
    return Number(payload.scheduledExecutionTime.seconds);
  }
  return Math.floor(Date.now() / 1000);
};

export const parseHttpInput = (payload: unknown): Record<string, unknown> => {
  if (typeof payload !== "object" || payload === null) {
    return {};
  }
  const maybeRecord = payload as Record<string, unknown>;
  const input = maybeRecord.input;
  if (!(input instanceof Uint8Array)) {
    return {};
  }
  try {
    const decoded = textDecoder.decode(input);
    const parsed = JSON.parse(decoded);
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return {};
  }
};

export const safeJson = (envelope: ExecutionEnvelope): string =>
  JSON.stringify(envelope);

export const registerBaseTriggers = <TConfig extends BaseWorkflowConfig>(
  config: TConfig,
  handlers: BaseHandlers<TConfig>
) => {
  const registrations: any[] = [];

  if (config.trigger.http.enabled) {
    const httpTrigger = new cre.capabilities.HTTPCapability().trigger({
      authorizedKeys: config.trigger.http.authorizedKeys.map((publicKey) => ({
        type: "KEY_TYPE_ECDSA_EVM",
        publicKey,
      })),
    });
    registrations.push(cre.handler(httpTrigger, handlers.onHttp as any));
  }

  if (config.trigger.evmLog.enabled) {
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

    const evmClient = new cre.capabilities.EVMClient(
      network.chainSelector.selector
    );
    const logTrigger = evmClient.logTrigger({
      addresses: config.trigger.evmLog.addresses,
      topics: [{ values: config.trigger.evmLog.topics.map(toHexTopic) }],
      confidence: config.trigger.evmLog.confidence,
    });
    registrations.push(cre.handler(logTrigger, handlers.onEvmLog as any));
  }

  if (config.trigger.cron.enabled) {
    const cronTrigger = new cre.capabilities.CronCapability().trigger({
      schedule: config.trigger.cron.schedule,
    });
    registrations.push(cre.handler(cronTrigger, handlers.onCron as any));
  }

  if (registrations.length === 0) {
    throw new Error("No triggers enabled; configure at least one trigger");
  }

  return registrations;
};
