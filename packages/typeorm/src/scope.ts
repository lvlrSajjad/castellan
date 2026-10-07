import {
  type Ability,
  CastellanError,
  EmptyScopeError,
  type ResolvedNode,
  type ResolvedScope,
  type SubjectType,
  assertResolvedScope,
} from '@castellan/core';
import { Brackets, type EntityMetadata, type ObjectLiteral, type SelectQueryBuilder } from 'typeorm';

export interface ApplyScopeOptions {
  /** Alias of the scoped entity. Default: the query builder's main alias. */
  alias?: string;
  /**
   * Join aliases for relation paths used in conditions (`site.region` → `{ site: 'site' }`).
   * Relations joined on the main alias are detected automatically.
   * Pass `false` to reject relation paths, so a scope never depends on a join (for schemas
   * without foreign keys, where a join could cross tenants).
   */
  relations?: Record<string, string> | false;
  /**
   * `'condition'`: throw {@link EmptyScopeError} when nothing is allowed, instead of adding `1=0`.
   * For code paths where a missing grant is a bug, not an empty list.
   */
  require?: 'condition';
}

/** @deprecated Use {@link ApplyScopeOptions}. */
export type ScopeQueryOptions = ApplyScopeOptions;

/** A SQL fragment with its named parameters. */
export interface SqlFragment {
  sql: string;
  params: Record<string, unknown>;
}

const TRUE = '1=1';
const FALSE = '1=0';
let paramCounter = 0;

interface ColumnResolver {
  column(field: string): string;
}

function createResolver(qb: SelectQueryBuilder<ObjectLiteral>, options: ApplyScopeOptions): ColumnResolver {
  const mainAlias = qb.expressionMap.mainAlias;
  if (!mainAlias?.hasMetadata) throw new CastellanError('applyScope needs a query builder created from an entity');
  const alias = options.alias ?? mainAlias.name;
  const metadata: EntityMetadata = qb.expressionMap.findAliasByName(alias).metadata;

  return {
    column(field) {
      const [head, tail] = field.split('.') as [string, string | undefined];
      if (tail === undefined) {
        const column = metadata.findColumnWithPropertyPath(head);
        if (!column) throw new CastellanError(`Unknown field "${field}" on ${metadata.name}`);
        return `${qb.escape(alias)}.${qb.escape(column.databaseName)}`;
      }
      if (options.relations === false) {
        throw new CastellanError(`Condition uses relation path "${field}", but relations are disabled for this scope`);
      }
      const relation = metadata.findRelationWithPropertyPath(head);
      if (!relation) throw new CastellanError(`Unknown relation "${head}" on ${metadata.name}`);
      const joinAlias =
        options.relations?.[head] ??
        qb.expressionMap.joinAttributes.find((j) => j.entityOrProperty === `${alias}.${head}`)?.alias.name;
      if (!joinAlias) {
        throw new CastellanError(
          `Condition uses "${field}" but relation "${head}" is not joined. ` +
            `Join it (e.g. qb.leftJoin('${alias}.${head}', '${head}')) or pass options.relations.`,
        );
      }
      const column = relation.inverseEntityMetadata.findColumnWithPropertyPath(tail);
      if (!column) throw new CastellanError(`Unknown field "${tail}" on ${relation.inverseEntityMetadata.name}`);
      return `${qb.escape(joinAlias)}.${qb.escape(column.databaseName)}`;
    },
  };
}

class SqlWriter {
  readonly params: Record<string, unknown> = {};
  private readonly prefix = `castellan_${++paramCounter}_`;
  private index = 0;

  constructor(private readonly resolver: ColumnResolver) {}

  private param(value: unknown): string {
    const name = `${this.prefix}${this.index++}`;
    this.params[name] = value;
    return `:${name}`;
  }

  private listParam(values: unknown[]): string {
    const name = `${this.prefix}${this.index++}`;
    this.params[name] = values;
    return `(:...${name})`;
  }

  write(node: ResolvedNode): string {
    switch (node.kind) {
      case 'const':
        return node.value ? TRUE : FALSE;
      case 'and':
      case 'or':
        return `(${node.nodes.map((n) => this.write(n)).join(node.kind === 'and' ? ' AND ' : ' OR ')})`;
      case 'not':
        return `NOT (${this.write(node.node)})`;
      case 'field':
        return this.field(node);
    }
  }

  private field(node: Extract<ResolvedNode, { kind: 'field' }>): string {
    const col = this.resolver.column(node.field);
    const value = node.value;
    switch (node.op) {
      case '$exists':
        return value ? `${col} IS NOT NULL` : `${col} IS NULL`;
      case '$eq':
        return value === null ? `${col} IS NULL` : `${col} = ${this.param(value)}`;
      case '$ne':
        return value === null ? `${col} IS NOT NULL` : `(${col} <> ${this.param(value)} OR ${col} IS NULL)`;
      case '$in': {
        const list = value as unknown[];
        const values = list.filter((v) => v !== null && v !== undefined);
        const hasNull = values.length !== list.length;
        const inSql = values.length ? `${col} IN ${this.listParam(values)}` : FALSE;
        return hasNull ? `(${inSql} OR ${col} IS NULL)` : inSql;
      }
      case '$nin': {
        const list = value as unknown[];
        const values = list.filter((v) => v !== null && v !== undefined);
        const hasNull = values.length !== list.length;
        if (!values.length) return hasNull ? `${col} IS NOT NULL` : TRUE;
        const notIn = `${col} NOT IN ${this.listParam(values)}`;
        return hasNull ? `(${notIn} AND ${col} IS NOT NULL)` : `(${notIn} OR ${col} IS NULL)`;
      }
      default: {
        if (value === null) return FALSE;
        const op = { $gt: '>', $gte: '>=', $lt: '<', $lte: '<=' }[node.op];
        return `${col} ${op} ${this.param(value)}`;
      }
    }
  }
}

/**
 * Writes a resolved scope as SQL against a query builder's entity. Values are bound parameters;
 * column names are checked against TypeORM metadata. The scope is validated first, so `undefined`,
 * `null` or `{}` throw instead of producing an unfiltered query.
 */
export function buildScopeSql<T extends ObjectLiteral>(
  qb: SelectQueryBuilder<T>,
  resolved: ResolvedScope,
  options: ApplyScopeOptions = {},
): SqlFragment {
  assertResolvedScope(resolved);
  if (resolved.kind === 'none') {
    if (options.require === 'condition') throw new EmptyScopeError('No rule grants access: the scope is empty');
    return { sql: FALSE, params: {} };
  }
  const writer = new SqlWriter(createResolver(qb as SelectQueryBuilder<ObjectLiteral>, options));
  return { sql: writer.write(resolved.node), params: writer.params };
}

/**
 * Applies a resolved scope (from `ability.resolveScope()` / `resolveScope()`) to a query builder
 * and returns the same builder.
 *
 * Existing WHERE conditions are wrapped in brackets first, because TypeORM does not parenthesize
 * raw strings: without this, `where('a OR b')` + scope would become `a OR (b AND scope)`.
 * Apply the scope **after** your own `where`/`orWhere` calls: a later `.where()` replaces it and a
 * later `.orWhere()` widens it.
 *
 * @example
 * ```ts
 * const resolved = ability.resolveScope('read', WorkOrder);
 * if (resolved.kind === 'none') throw new NotFoundException();
 * applyScope(repo.createQueryBuilder('wo'), resolved).getMany();
 * ```
 */
export function applyScope<T extends ObjectLiteral>(
  qb: SelectQueryBuilder<T>,
  resolved: ResolvedScope,
  options: ApplyScopeOptions = {},
): SelectQueryBuilder<T> {
  const { sql, params } = buildScopeSql(qb, resolved, options);
  const prior = qb.expressionMap.wheres;
  if (prior.length) {
    qb.expressionMap.wheres = [{ type: 'simple', condition: { operator: 'brackets', condition: prior } }];
  }
  return qb.andWhere(new Brackets((where) => where.where(sql, params)));
}

/**
 * Restricts a TypeORM query to the rows `ability` allows for `action` — the TypeORM equivalent of
 * CASL's `accessibleBy`. Shorthand for `applyScope(qb, ability.resolveScope(action, Subject), options)`.
 *
 * @example
 * ```ts
 * const qb = repo.createQueryBuilder('wo');
 * scopeQuery(qb, ability, 'read', WorkOrder, { require: 'condition' });
 * ```
 */
export function scopeQuery<T extends ObjectLiteral>(
  qb: SelectQueryBuilder<T>,
  ability: Pick<Ability<string>, 'resolveScope'>,
  action: string,
  subjectType: SubjectType,
  options: ApplyScopeOptions = {},
): SelectQueryBuilder<T> {
  return applyScope(qb, ability.resolveScope(action, subjectType), options);
}
