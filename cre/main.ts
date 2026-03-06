import { Runner, type EVMLog, type Runtime } from "@chainlink/cre-sdk";
import { runComplianceVaultFlow } from "./flow";
import { registerEvmLogTrigger, safeJson } from "./runtime";
import { parseWorkflowConfig, type WorkflowConfig } from "./types";

const PROFILE_ID = "COMPLIANCE_VAULT_V1" as const;

const onEvmLogTrigger = (
  runtime: Runtime<WorkflowConfig>,
  payload: EVMLog
): string => {
  runtime.log(`[${PROFILE_ID}] EVM log trigger received`);
  const result = runComplianceVaultFlow(runtime, runtime.config, payload);
  return safeJson(result);
};

const initWorkflow = (rawConfig: WorkflowConfig) => {
  const parsed = parseWorkflowConfig(rawConfig);
  return registerEvmLogTrigger(parsed, onEvmLogTrigger);
};

export async function main() {
  const runner = await Runner.newRunner<WorkflowConfig>();
  await runner.run(initWorkflow);
}

main();
