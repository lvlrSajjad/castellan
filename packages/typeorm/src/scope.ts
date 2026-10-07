import {
  type Ability,
  CastellanError,
  type ConditionNode,
  type Operand,
  type Rule,
  type SubjectType,
  UnresolvedRefError,
  normalizeConditions,
  resolveList,
  resolveOperand,
  reviveConditions,
} from '@castellan/core';
import { Brackets, type EntityMetadata, type ObjectLiteral, type SelectQueryBuilder } from 'typeorm';

export interface ScopeQueryOptions {
  /** Alias of the scoped entity. Default: the query builder's main alias. */
  alias?: string;
  /**
   * Join aliases for relation paths used in conditions (`site.region` → `{ site: 'site' }`).
   * Relations joined on the main alias are detected automatically.
   */
  relations?: Record<string, string>;
}

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

function createResolver(qb: SelectQueryBuilder<ObjectLiteral>, options: ScopeQueryOptions): ColumnResolver {
  const mainAlias = qb.expressionMap.mainAlias;
  if (!mainAlias?.hasMetadata) throw new CastellanError('scopeQuery needs a query builder created from an entity');
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

class SqlBuilder {
  readonly params: Record<string, unknown> = {};
  private readonly prefix = `castellan_${++paramCounter}_`;
  private index = 0;

  constructor(
    private readonly resolver: ColumnResolver,
    private readonly user: unknown,
  ) {}

  param(value: unknown): string {
    const name = `${this.prefix}${this.index++}`;
    this.params[name] = value;
    return `:${name}`;
  }

  listParam(values: unknown[]): string {
    const name = `${this.prefix}${this.index++}`;
    this.params[name] = values;
    return `(:...${name})`;
  }

  node(node: ConditionNode): string {
    if (node.kind === 'and' || node.kind === 'or') {
      const parts = node.nodes.map((n) => this.node(n));
      return `(${parts.join(node.kind === 'and' ? ' AND ' : ' OR ')})`;
    }
    const col = this.resolver.column(node.field);
    switch (node.op) {
      case '$exists':
        return (node.operand as { value: boolean }).value ? `${col} IS NOT NULL` : `${col} IS NULL`;
      case '$eq': {
        const value = resolveOperand(node.operand as Operand, this.user);
        return value === null ? `${col} IS NULL` : `${col} = ${this.param(value)}`;
      }
      case '$ne': {
        const value = resolveOperand(node.operand as Operand, this.user);
        return value === null ? `${col} IS NOT NULL` : `(${col} <> ${this.param(value)} OR ${col} IS NULL)`;
      }
      case '$in': {
        const list = resolveList(node.operand, this.user);
        const values = list.filter((v) => v !== null && v !== undefined);
        const hasNull = values.length !== list.length;
        const inSql = values.length ? `${col} IN ${this.listParam(values)}` : FALSE;
        return hasNull ? `(${inSql} OR ${col} IS NULL)` : inSql;
      }
      case '$nin': {
        const list = resolveList(node.operand, this.user);
        const values = list.filter((v) => v !== null && v !== undefined);
        const hasNull = values.length !== list.length;
        if (!values.length) return hasNull ? `${col} IS NOT NULL` : TRUE;
        const notIn = `${col} NOT IN ${this.listParam(values)}`;
        return hasNull ? `(${notIn} AND ${col} IS NOT NULL)` : `(${notIn} OR ${col} IS NULL)`;
      }
      default: {
        const value = resolveOperand(node.operand as Operand, this.user);
        if (value === null) return FALSE;
        const op = { $gt: '>', $gte: '>=', $lt: '<', $lte: '<=' }[node.op];
        return `${col} ${op} ${this.param(value)}`;
      }
    }
  }

  /** SQL for one rule's conditions, failing closed on unresolved refs. */
  rule(rule: Rule): string {
    if (!rule.conditions) return TRUE;
    try {
      return this.node(normalizeConditions(reviveConditions(rule.conditions)));
    } catch (error) {
      if (error instanceof UnresolvedRefError) return rule.effect === 'allow' ? FALSE : TRUE;
      throw error;
    }
  }
}

/**
 * Builds the SQL that restricts a query to rows the ability allows:
 * `(allow1 OR allow2 …) AND NOT (deny1 OR deny2 …)`. All values are bound parameters.
 */
export function buildScopeSql<T extends ObjectLiteral>(
  qb: SelectQueryBuilder<T>,
  ability: Ability<string>,
  action: string,
  subjectType: SubjectType,
  options: ScopeQueryOptions = {},
): SqlFragment {
  const { allow, deny } = ability.rulesFor(action, subjectType);
  if (!allow.length) return { sql: FALSE, params: {} };
  const builder = new SqlBuilder(createResolver(qb as SelectQueryBuilder<ObjectLiteral>, options), ability.user);
  const allowSql = allow.map((r) => builder.rule(r));
  const denySql = deny.map((r) => builder.rule(r));
  let sql = allowSql.includes(TRUE) ? TRUE : `(${allowSql.join(' OR ')})`;
  if (denySql.length) sql = `${sql} AND NOT (${denySql.join(' OR ')})`;
  return { sql, params: builder.params };
}

/**
 * Restricts a TypeORM query to the rows `ability` allows for `action` — the TypeORM
 * equivalent of CASL's `accessibleBy`. Returns the same builder.
 *
 * Existing WHERE conditions are wrapped in brackets first, because TypeORM does not parenthesize
 * raw strings: without this, `where('a OR b')` + scope would become `a OR (b AND scope)`.
 * Call `scopeQuery` **after** your own `where`/`orWhere` calls: a later `.where()` replaces the
 * scope and a later `.orWhere()` widens it.
 *
 * @example
 * ```ts
 * const qb = repo.createQueryBuilder('wo').leftJoin('wo.site', 'site');
 * scopeQuery(qb, ability, 'read', WorkOrder);
 * const rows = await qb.getMany();
 * ```
 */
export function scopeQuery<T extends ObjectLiteral>(
  qb: SelectQueryBuilder<T>,
  ability: Ability<string>,
  action: string,
  subjectType: SubjectType,
  options: ScopeQueryOptions = {},
): SelectQueryBuilder<T> {
  const { sql, params } = buildScopeSql(qb, ability, action, subjectType, options);
  const prior = qb.expressionMap.wheres;
  if (prior.length) {
    qb.expressionMap.wheres = [{ type: 'simple', condition: { operator: 'brackets', condition: prior } }];
  }
  return qb.andWhere(new Brackets((where) => where.where(sql, params)));
}
