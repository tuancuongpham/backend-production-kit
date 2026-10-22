// Embeddings without an embedding API, for the vector tests (pgvector, the semantic cache, hybrid search).

/** A deterministic pseudo-embedding: the same seed always gives the same vector. */
export function fakeEmbedding(seed: number, dims = 1536): number[] {
  const v: number[] = [];
  let x = seed * 9301 + 49297;
  for (let i = 0; i < dims; i++) {
    x = (x * 9301 + 49297) % 233280;
    v.push(x / 233280 - 0.5);
  }
  return v;
}

/** pgvector's text form: [0.1,0.2,…]. */
export const toVectorLiteral = (v: number[]) => `[${v.join(',')}]`;
