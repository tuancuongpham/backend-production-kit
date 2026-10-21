import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export const ADMIN_URL = process.env.KIT_PG_URL ?? 'postgres://kit:kit@localhost:55439/kit';
export const REDIS_URL = process.env.KIT_REDIS_URL ?? 'redis://localhost:63799';

const kitRoot = fileURLToPath(new URL('../../', import.meta.url));

export function skillFile(skill: string, file: string): string {
  return `${kitRoot}skills/${skill}/references/${file}`;
}

export async function readSkillFile(skill: string, file: string): Promise<string> {
  return readFile(skillFile(skill, file), 'utf8');
}

/** Runs a reference .sql file as the admin (owner) role. */
export async function runSqlFile(admin: pg.Client | pg.Pool, skill: string, file: string): Promise<void> {
  await admin.query(await readSkillFile(skill, file));
}

/** Each test file gets its own database so files can't interfere with each other. */
export async function freshDatabase(name: string): Promise<string> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

export function withUser(dbUrl: string, user: string, password: string): string {
  const url = new URL(dbUrl);
  url.username = user;
  url.password = password;
  return url.toString();
}

/** Deterministic pseudo-embedding so vector tests don't need an embedding API. */
export function fakeEmbedding(seed: number, dims = 1536): number[] {
  const v: number[] = [];
  let x = seed * 9301 + 49297;
  for (let i = 0; i < dims; i++) {
    x = (x * 9301 + 49297) % 233280;
    v.push(x / 233280 - 0.5);
  }
  return v;
}

export const toVectorLiteral = (v: number[]) => `[${v.join(',')}]`;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
