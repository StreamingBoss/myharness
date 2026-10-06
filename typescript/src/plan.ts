/** `update_plan` is a note to the model and the user: it validates the list and changes nothing else. */
export const PLAN_STATUSES = ['pending', 'in_progress', 'done'] as const;
const MARKS: Record<string, string> = { pending: '[ ]', in_progress: '[~]', done: '[x]' };
const MAX_STEPS = 30, MAX_STEP_CHARS = 200;

export interface PlanItem { step: string; status: string }

export function planItems(value: unknown): PlanItem[] {
  if (!Array.isArray(value) || !value.length || value.length > MAX_STEPS) throw new Error(`items must be a list of 1 to ${MAX_STEPS} steps`);
  return value.map((item: unknown, index) => {
    const entry = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
    if (typeof entry.step !== 'string' || !entry.step.trim() || entry.step.length > MAX_STEP_CHARS) throw new Error(`step ${index + 1} needs a "step" text of at most ${MAX_STEP_CHARS} characters`);
    if (typeof entry.status !== 'string' || !(PLAN_STATUSES as readonly string[]).includes(entry.status)) throw new Error(`step ${index + 1} needs a "status" of pending, in_progress or done`);
    return { step: entry.step.trim(), status: entry.status };
  });
}

/** The result the model gets back: the plan as a checklist, so it stays in its context. */
export function planText(value: unknown): string {
  const items = planItems(value), done = items.filter(item => item.status === 'done').length;
  return `Plan updated (${done} of ${items.length} done):\n${items.map(item => `${MARKS[item.status]} ${item.step}`).join('\n')}`;
}
