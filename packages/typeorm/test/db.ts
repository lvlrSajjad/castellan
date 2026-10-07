import { DataSource, type DataSourceOptions, type EntitySchema } from 'typeorm';

/** Which database the suite runs on: SQLite in memory by default, or Postgres / MySQL from env. */
export const PG_URL = process.env.CASTELLAN_PG_URL;
export const MYSQL_URL = process.env.CASTELLAN_MYSQL_URL;
export const DB: 'sqlite' | 'postgres' | 'mysql' = MYSQL_URL ? 'mysql' : PG_URL ? 'postgres' : 'sqlite';

/** Timestamp column type for the current database. */
export const DATE_TYPE = DB === 'postgres' ? 'timestamptz' : 'datetime';

// biome-ignore lint: entity constructors are heterogeneous
type Entities = Array<(new () => unknown) | EntitySchema | (abstract new (...args: any[]) => unknown)>;

export function createTestDataSource(entities: Entities): DataSource {
  const common = { entities, synchronize: true, dropSchema: true } as const;
  const options: DataSourceOptions =
    DB === 'mysql'
      ? { type: 'mysql', url: MYSQL_URL, ...common }
      : DB === 'postgres'
        ? { type: 'postgres', url: PG_URL, ...common }
        : { type: 'better-sqlite3', database: ':memory:', ...common };
  return new DataSource(options as DataSourceOptions);
}
