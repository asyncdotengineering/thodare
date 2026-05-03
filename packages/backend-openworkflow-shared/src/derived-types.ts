import type { OpenWorkflow } from "@thodare/openworkflow";

// OpenWorkflow.implementWorkflow reveals WorkflowSpec, WorkflowFunction.
type _OwImplFn = OpenWorkflow["implementWorkflow"];
type _OwImplParams = Parameters<_OwImplFn>;
export type OwWorkflowSpec = _OwImplParams[0];
export type OwWorkflowFunction = _OwImplParams[1];
// WorkflowFunctionParams and StepApi derived from WorkflowFunction.
export type OwWorkflowFunctionParams = Parameters<OwWorkflowFunction>[0];
export type OwStepApi = OwWorkflowFunctionParams["step"];
// StepWaitTimeout extracted from StepApi.waitForSignal options.
type _WaitForSignalOpts = Parameters<OwStepApi["waitForSignal"]>[0];
export type StepWaitTimeout = NonNullable<_WaitForSignalOpts["timeout"]>;
