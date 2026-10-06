import { positiveLimit } from './execution.js';

export interface OrchestrationLimits {
  masterTimeoutMs: number; childTimeoutMs: number; maxRounds: number; maxRequests: number; maxConcurrentChildren: number;
}
export const DEFAULT_ORCHESTRATION_LIMITS: OrchestrationLimits = {
  masterTimeoutMs: 1_800_000, childTimeoutMs: 300_000, maxRounds: 10, maxRequests: 200, maxConcurrentChildren: 3,
};
export function orchestrationLimits(value: Partial<OrchestrationLimits> = {}): OrchestrationLimits {
  const limits = { ...DEFAULT_ORCHESTRATION_LIMITS, ...value };
  for (const [name, limit] of Object.entries(limits)) positiveLimit(limit, name);
  return limits;
}
export function boundedLimit(value: unknown, maximum: number, name: string): number {
  const limit = positiveLimit(value, name);
  if (limit > maximum) throw new Error(`${name} exceeds the harness limit (${maximum}).`);
  return limit;
}
