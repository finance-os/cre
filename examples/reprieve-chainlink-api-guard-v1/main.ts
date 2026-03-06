import { Runner, type Runtime, type EVMLog, type CronPayload } from "@chainlink/cre-sdk";
import {
  type ChainlinkApiGuardConfig,
  buildEnvelope,
  parseProfileWorkflowConfig,
} from "./types";
import {
  parseHttpInput,
  registerBaseTriggers,
  resolveCronTimestampSeconds,
  safeJson,
} from "./runtime";
import {
  reconcileChainlinkApiGuardLog,
  runChainlinkApiGuardFlow,
} from "./lib/full-flow-v1";

const PROFILE_ID = "CHAINLINK_API_GUARD_V1" as const;

const onHttpTrigger = (runtime: Runtime<ChainlinkApiGuardConfig>, payload: unknown): string => {
  const body = parseHttpInput(payload);
  runtime.log(`[${PROFILE_ID}] HTTP trigger received`);
  const envelope = runChainlinkApiGuardFlow(runtime, runtime.config, "http", body);
  return safeJson(
    buildEnvelope({
      ...envelope,
      metadata: { ...envelope.metadata, trigger: "http" },
    })
  );
};

const onEvmLogTrigger = (runtime: Runtime<ChainlinkApiGuardConfig>, payload: EVMLog): string => {
  runtime.log(`[${PROFILE_ID}] EVM log trigger received`);
  const envelope = reconcileChainlinkApiGuardLog(runtime, runtime.config, payload);
  return safeJson(
    buildEnvelope({
      ...envelope,
      metadata: { ...envelope.metadata, trigger: "evm_log" },
    })
  );
};

const onCronTrigger = (runtime: Runtime<ChainlinkApiGuardConfig>, payload: CronPayload): string => {
  runtime.log(`[${PROFILE_ID}] cron trigger at ${resolveCronTimestampSeconds(payload)}`);
  const envelope = runChainlinkApiGuardFlow(runtime, runtime.config, "cron", {});
  return safeJson(
    buildEnvelope({
      ...envelope,
      metadata: { ...envelope.metadata, trigger: "cron" },
    })
  );
};

const initWorkflow = (rawConfig: ChainlinkApiGuardConfig) => {
  const parsed = parseProfileWorkflowConfig(
    rawConfig,
    PROFILE_ID
  ) as ChainlinkApiGuardConfig;

  return registerBaseTriggers(parsed, {
    onHttp: onHttpTrigger,
    onEvmLog: onEvmLogTrigger,
    onCron: onCronTrigger,
  });
};

export async function main() {
  const runner = await Runner.newRunner<ChainlinkApiGuardConfig>();
  await runner.run(initWorkflow);
}

main();
