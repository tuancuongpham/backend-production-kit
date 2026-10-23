// LLM-as-judge for answers: grade each answer against the context it was given, and measure how often the judge
// agrees with human labels before its scores are allowed to gate anything.
import { mapInOrder, type RunOptions } from './retrieval-eval.ts';

export interface JudgeCase {
  id: string;
  question: string;
  /** The retrieved chunks the answer was generated from. */
  context: string[];
  answer: string;
  /** A human's label, on the calibration sample. */
  human?: Verdict;
}

export type Verdict = 'pass' | 'fail';
export type Judge = (c: JudgeCase) => Promise<{ verdict: Verdict; reason: string }>;

/**
 * Groundedness prompt for a judge model. Ask for a verdict on one property at a time: "is every claim supported
 * by the context?" is gradeable; "is this a good answer?" isn't.
 */
export const GROUNDEDNESS_PROMPT = `You are grading an answer produced by a support assistant.
Context the assistant was given:
<context>
{{context}}
</context>
Question: {{question}}
Answer: {{answer}}

Is every factual claim in the answer supported by the context? Numbers, dates, prices, names and policies must
appear in the context. An answer that says it doesn't know is supported.
Reply with JSON only: {"verdict": "pass" | "fail", "reason": "<one sentence naming the unsupported claim, if any>"}`;

/**
 * One pass with a replacer function: text inserted for one placeholder is never scanned for the others (an answer
 * that contains "{{context}}" stays as written), and `$&` or `$'` in it are not replacement patterns.
 */
export const fillPrompt = (c: JudgeCase) => {
  const values: Record<string, string> = {
    context: c.context.map((t, i) => `[${i + 1}] ${t}`).join('\n'),
    question: c.question,
    answer: c.answer,
  };
  return GROUNDEDNESS_PROMPT.replace(/\{\{(context|question|answer)\}\}/g, (_, name: string) => values[name]);
};

/** Grades every case, `concurrency` judge calls at a time (default 4): at about a second per call, one at a time is slow. */
export async function runJudge(cases: JudgeCase[], judge: Judge, opts: RunOptions = {}) {
  const results = await mapInOrder(cases, async (c) => ({ ...c, ...checkedReply(c, await judge(c)) }), opts);
  return { results, passRate: results.filter((r) => r.verdict === 'pass').length / Math.max(1, results.length) };
}

/**
 * The judge's reply, checked: it is usually a model's JSON, parsed as written. "Pass" or " FAIL " counts as what it
 * says (it counted as a fail); any other verdict is an error naming the case, not a silent fail. Only verdict and
 * reason are taken: extra keys in the reply (a "human" that the answer under test talked the judge into) overwrote
 * the case, human label included, and the agreement with humans was then measured against the judge itself.
 */
function checkedReply(c: JudgeCase, reply: unknown): { verdict: Verdict; reason: string } {
  const r = (reply ?? {}) as { verdict?: unknown; reason?: unknown };
  const verdict = typeof r.verdict === 'string' ? r.verdict.trim().toLowerCase() : r.verdict;
  if (verdict !== 'pass' && verdict !== 'fail') throw new TypeError(`judge: case ${c.id}: verdict must be "pass" or "fail", got ${JSON.stringify(r.verdict)}`);
  return { verdict, reason: typeof r.reason === 'string' ? r.reason : '' };
}

/** Cohen's kappa: agreement corrected for chance. 1 = perfect, 0 = no better than chance. */
export function cohensKappa(a: string[], b: string[]): number {
  if (a.length !== b.length || a.length === 0) throw new Error('kappa needs two label lists of the same, non-zero length');
  const n = a.length;
  const labels = [...new Set([...a, ...b])];
  const observed = a.filter((x, i) => x === b[i]).length / n;
  const expected = labels.reduce((s, l) => s + (a.filter((x) => x === l).length / n) * (b.filter((x) => x === l).length / n), 0);
  return expected === 1 ? 1 : (observed - expected) / (1 - expected);
}

/**
 * How far to trust the judge: run it on human-labelled cases and compare. Below ~0.6 kappa, its scores are noise
 * for gating. Re-check whenever the judge model or prompt changes.
 */
export function judgeAgreement(results: Array<{ verdict: Verdict; human?: Verdict }>) {
  const labelled = results.filter((r): r is { verdict: Verdict; human: Verdict } => r.human !== undefined);
  const judge = labelled.map((r) => r.verdict);
  const human = labelled.map((r) => r.human);
  const count = (j: Verdict, h: Verdict) => labelled.filter((r) => r.verdict === j && r.human === h).length;
  return {
    cases: labelled.length,
    accuracy: labelled.filter((r) => r.verdict === r.human).length / Math.max(1, labelled.length),
    kappa: cohensKappa(judge, human),
    /** The judge passed what a human failed: the dangerous direction. */
    falsePasses: count('pass', 'fail'),
    falseFails: count('fail', 'pass'),
  };
}
