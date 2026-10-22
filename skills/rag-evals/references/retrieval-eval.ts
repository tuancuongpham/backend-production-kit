// Retrieval evaluation for RAG: metrics over a labelled golden set, a report per run, and a regression gate for CI.
// A retriever is any function from a query to a ranked list of ids, so the same harness checks hybrid search,
// a new embedding model, another chunk size or a reranker.

export interface GoldenQuery {
  id: string;
  query: string;
  /** Ids of the chunks or documents a good answer needs. */
  relevant: string[];
  /** For slices in the report: 'billing', 'vi-no-accents', 'long-tail'… */
  tags?: string[];
}

export type Retriever = (q: GoldenQuery) => Promise<string[]>;

/**
 * The first occurrence of each id, in order. Retrievers return duplicates whenever relevance is judged at a
 * coarser level than retrieval (chunks mapped to their documents): counting them twice pushes recall above 1.
 */
const unique = (ids: string[]) => [...new Set(ids)];

export const recallAtK = (retrieved: string[], relevant: string[], k: number) => {
  const want = new Set(relevant);
  return want.size === 0 ? 1 : unique(retrieved).slice(0, k).filter((id) => want.has(id)).length / want.size;
};

export const precisionAtK = (retrieved: string[], relevant: string[], k: number) => {
  const want = new Set(relevant);
  return unique(retrieved).slice(0, k).filter((id) => want.has(id)).length / k;
};

/** 1 / rank of the first relevant result; 0 when none was retrieved. */
export const reciprocalRank = (retrieved: string[], relevant: string[]) => {
  const want = new Set(relevant);
  const i = unique(retrieved).findIndex((id) => want.has(id));
  return i < 0 ? 0 : 1 / (i + 1);
};

/** nDCG@k with binary relevance: rewards putting the relevant results first. */
export const ndcgAtK = (retrieved: string[], relevant: string[], k: number) => {
  const want = new Set(relevant);
  const dcg = unique(retrieved).slice(0, k).reduce((s, id, i) => s + (want.has(id) ? 1 / Math.log2(i + 2) : 0), 0);
  const ideal = Array.from({ length: Math.min(k, want.size) }, (_, i) => 1 / Math.log2(i + 2)).reduce((a, b) => a + b, 0);
  return ideal === 0 ? 1 : dcg / ideal;
};

export interface QueryResult {
  id: string;
  query: string;
  tags: string[];
  retrieved: string[];
  missed: string[];
  recall: number;
  reciprocalRank: number;
  ndcg: number;
}

export interface Report {
  k: number;
  queries: number;
  recall: number;
  precision: number;
  mrr: number;
  ndcg: number;
  hitRate: number;
  byTag: Record<string, { queries: number; recall: number }>;
  perQuery: QueryResult[];
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const round = (x: number) => Math.round(x * 1000) / 1000;

export async function evaluateRetriever(golden: GoldenQuery[], retrieve: Retriever, k = 5): Promise<Report> {
  if (!Number.isInteger(k) || k < 1) throw new RangeError(`evaluateRetriever: k must be a positive integer, got ${k}`);
  const perQuery: QueryResult[] = [];
  let precision = 0;
  for (const q of golden) {
    const retrieved = unique(await retrieve(q)).slice(0, k);
    precision += precisionAtK(retrieved, q.relevant, k);
    perQuery.push({
      id: q.id,
      query: q.query,
      tags: q.tags ?? [],
      retrieved,
      missed: q.relevant.filter((id) => !retrieved.includes(id)),
      recall: recallAtK(retrieved, q.relevant, k),
      reciprocalRank: reciprocalRank(retrieved, q.relevant),
      ndcg: ndcgAtK(retrieved, q.relevant, k),
    });
  }
  const byTag: Report['byTag'] = {};
  for (const tag of new Set(perQuery.flatMap((r) => r.tags))) {
    const rows = perQuery.filter((r) => r.tags.includes(tag));
    byTag[tag] = { queries: rows.length, recall: round(mean(rows.map((r) => r.recall))) };
  }
  return {
    k,
    queries: golden.length,
    recall: round(mean(perQuery.map((r) => r.recall))),
    precision: round(precision / Math.max(1, golden.length)),
    mrr: round(mean(perQuery.map((r) => r.reciprocalRank))),
    ndcg: round(mean(perQuery.map((r) => r.ndcg))),
    hitRate: round(mean(perQuery.map((r) => (r.recall > 0 ? 1 : 0)))),
    byTag,
    perQuery,
  };
}

export interface Gate {
  /** Largest acceptable drop in recall@k (absolute). Default 0.02. */
  maxRecallDrop?: number;
  /** Largest acceptable drop in MRR (absolute). Default 0.02. */
  maxMrrDrop?: number;
  /** Largest acceptable recall drop within any tag slice. Default 0.05: an average can hide a broken slice. */
  maxSliceDrop?: number;
}

/**
 * Compare a candidate run with the baseline (main branch). `pass: false` fails the CI job.
 * Both runs are compared on the queries they share: a pull request that adds hard questions to the golden set
 * lowers the candidate's average without anything getting worse, and must not fail the gate for it. Added and
 * removed queries are listed instead.
 */
export function compareReports(baseline: Report, candidate: Report, gate: Gate = {}) {
  const before = new Map(baseline.perQuery.map((r) => [r.id, r]));
  const after = new Map(candidate.perQuery.map((r) => [r.id, r]));
  const shared = candidate.perQuery.filter((r) => before.has(r.id)).map((r) => r.id);
  const added = candidate.perQuery.filter((r) => !before.has(r.id)).map((r) => r.id);
  const removed = baseline.perQuery.filter((r) => !after.has(r.id)).map((r) => r.id);
  const avg = (runs: Map<string, QueryResult>, ids: string[], metric: (r: QueryResult) => number) => mean(ids.map((id) => metric(runs.get(id)!)));
  const delta = (ids: string[], metric: (r: QueryResult) => number) => round(avg(after, ids, metric) - avg(before, ids, metric));
  const deltas = {
    recall: delta(shared, (r) => r.recall),
    mrr: delta(shared, (r) => r.reciprocalRank),
    ndcg: delta(shared, (r) => r.ndcg),
  };
  const tags = [...new Set(shared.flatMap((id) => before.get(id)!.tags))];
  const slices = tags.map((tag) => ({ tag, delta: delta(shared.filter((id) => before.get(id)!.tags.includes(tag)), (r) => r.recall) }));
  const failures = [
    // recall@10 against recall@5 always looks like progress: a pull request that changes k must not pass for it.
    ...(baseline.k !== candidate.k ? [`the runs use different k (${baseline.k} and ${candidate.k}): their metrics can't be compared`] : []),
    ...(shared.length === 0 ? ['the two runs share no queries: nothing to compare'] : []),
    ...(deltas.recall < -(gate.maxRecallDrop ?? 0.02) ? [`recall@${candidate.k} fell by ${-deltas.recall}`] : []),
    ...(deltas.mrr < -(gate.maxMrrDrop ?? 0.02) ? [`MRR fell by ${-deltas.mrr}`] : []),
    ...slices.filter((s) => s.delta < -(gate.maxSliceDrop ?? 0.05)).map((s) => `recall in "${s.tag}" fell by ${-s.delta}`),
  ];
  const regressed = shared
    .map((id) => ({ was: before.get(id)!, now: after.get(id)! }))
    .filter(({ was, now }) => now.recall < was.recall)
    .map(({ was, now }) => ({ id: now.id, query: now.query, was: was.recall, now: now.recall, missed: now.missed }));
  return { pass: failures.length === 0, failures, deltas, regressed, added, removed };
}

/** A short markdown summary for the pull request. */
export function toMarkdown(baseline: Report, candidate: Report, comparison: ReturnType<typeof compareReports>) {
  const row = (name: string, r: Report) => `| ${name} | ${r.recall} | ${r.mrr} | ${r.ndcg} | ${r.hitRate} |`;
  return [
    `**Retrieval eval: ${comparison.pass ? 'pass' : 'FAIL'}** (${candidate.queries} queries, k = ${candidate.k})`,
    '',
    `| run | recall@${candidate.k} | MRR | nDCG@${candidate.k} | hit rate |`,
    '|---|---|---|---|---|',
    row('baseline', baseline),
    row('this change', candidate),
    ...(comparison.added.length || comparison.removed.length
      ? ['', `Golden set changed: ${comparison.added.length} queries added, ${comparison.removed.length} removed (compared on the ${candidate.queries - comparison.added.length} shared).`]
      : []),
    ...(comparison.failures.length ? ['', ...comparison.failures.map((f) => `- ${f}`)] : []),
    ...(comparison.regressed.length
      ? ['', 'Queries that lost relevant results:', ...comparison.regressed.slice(0, 10).map((r) => `- \`${r.query}\`: recall ${r.was} → ${r.now}`)]
      : []),
  ].join('\n');
}
