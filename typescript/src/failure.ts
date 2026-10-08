/** Safe, structured diagnostics shared by headless backends and their transports. */
export type FailureSource = 'model' | 'harness' | 'bridge' | 'transport';
export interface FailureDetails { source: FailureSource; component: string; reason: string; recovery: string }
export class DiagnosticError extends Error {
  constructor(readonly failure: FailureDetails) { super(failure.reason); }
}
export function failureDetails(error: unknown, source: FailureSource = 'harness', component = 'Harness backend', recovery = 'Check the selected workspace and harness settings, then retry.'): FailureDetails {
  if (error instanceof Error && 'failure' in error && error.failure) return error.failure as FailureDetails;
  return { source, component, reason: String(error instanceof Error ? error.message : error), recovery };
}
/** Callers supply a safe fallback when a transport did not provide details. */
export function failureText(error: unknown, fallback: string): string {
  if (!(error instanceof Error) || !('failure' in error) || !error.failure) return fallback;
  const failure = error.failure as FailureDetails;
  return `Source: ${failure.source} — ${failure.component}\nReason: ${failure.reason}\nNext: ${failure.recovery}`;
}
