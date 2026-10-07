import type { DataSource, ObjectLiteral, SelectQueryBuilder } from 'typeorm';
import { DB } from './db.js';

/**
 * Runs EXPLAIN for a scoped query and throws if the scoped table is read with a full scan.
 * Use it on scopes whose column is indexed. On Postgres, sequential scans are disabled for the
 * check so a small test table does not hide a missing index.
 */
export async function explainScope<T extends ObjectLiteral>(ds: DataSource, qb: SelectQueryBuilder<T>): Promise<string> {
  const [sql, params] = qb.getQueryAndParameters();
  const alias = qb.alias;
  const table = qb.expressionMap.mainAlias!.metadata.tableName;
  const runner = ds.createQueryRunner();
  try {
    if (DB === 'mysql') {
      const rows: Array<{ table: string; type: string; key: string | null }> = await runner.query(`EXPLAIN ${sql}`, params);
      const row = rows.find((r) => r.table === alias || r.table === table);
      const plan = JSON.stringify(rows);
      if (!row || row.type === 'ALL') throw new Error(`Full table scan on ${table}: ${plan}`);
      return plan;
    }
    if (DB === 'postgres') {
      await runner.startTransaction();
      await runner.query('SET LOCAL enable_seqscan = off');
      const rows: Array<{ 'QUERY PLAN': string }> = await runner.query(`EXPLAIN ${sql}`, params);
      await runner.rollbackTransaction();
      const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
      if (new RegExp(`Seq Scan on "?${table}"?`).test(plan)) throw new Error(`Full table scan on ${table}:\n${plan}`);
      return plan;
    }
    const rows: Array<{ detail: string }> = await runner.query(`EXPLAIN QUERY PLAN ${sql}`, params);
    const plan = rows.map((r) => r.detail).join('\n');
    if (new RegExp(`^SCAN (${alias}|${table})$`, 'm').test(plan)) throw new Error(`Full table scan on ${table}:\n${plan}`);
    return plan;
  } finally {
    await runner.release();
  }
}
