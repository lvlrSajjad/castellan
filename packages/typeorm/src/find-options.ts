import {
  type Ability,
  CastellanError,
  type ResolvedNode,
  type SubjectType,
  assertResolvedScope,
} from '@castellan/core';
import {
  And,
  Equal,
  FindOperator,
  type FindOptionsWhere,
  In,
  IsNull,
  LessThan,
  LessThanOrEqual,
  MoreThan,
  MoreThanOrEqual,
  Not,
  Or,
} from 'typeorm';

type Leaf = FindOperator<unknown> | unknown;
type Conjunction = Map<string, Leaf[]>;

/** Leaf that can never match (e.g. `$in: []`). */
const NEVER = Symbol('never');
/** Leaf that always matches (e.g. `$nin: []`). */
const ALWAYS = Symbol('always');

const MAX_BRANCHES = 64;

function leaf(node: Extract<ResolvedNode, { kind: 'field' }>): Leaf | typeof NEVER | typeof ALWAYS {
  const v = node.value;
  switch (node.op) {
    case '$exists':
      return v ? Not(IsNull()) : IsNull();
    case '$eq':
      return v === null ? IsNull() : v;
    case '$ne':
      return v === null ? Not(IsNull()) : Or(Not(v), IsNull());
    case '$in': {
      const list = v as unknown[];
      const values = list.filter((x) => x !== null && x !== undefined);
      const hasNull = values.length !== list.length;
      if (!values.length) return hasNull ? IsNull() : NEVER;
      return hasNull ? Or(In(values), IsNull()) : In(values);
    }
    case '$nin': {
      const list = v as unknown[];
      const values = list.filter((x) => x !== null && x !== undefined);
      const hasNull = values.length !== list.length;
      if (!values.length) return hasNull ? Not(IsNull()) : ALWAYS;
      return hasNull ? And(Not(In(values)), Not(IsNull())) : Or(Not(In(values)), IsNull());
    }
    default: {
      if (v === null) return NEVER;
      return { $gt: MoreThan, $gte: MoreThanOrEqual, $lt: LessThan, $lte: LessThanOrEqual }[node.op](v);
    }
  }
}

function product(a: Conjunction[], b: Conjunction[]): Conjunction[] {
  const out: Conjunction[] = [];
  for (const x of a) {
    for (const y of b) {
      const merged = new Map(x);
      for (const [k, v] of y) merged.set(k, [...(merged.get(k) ?? []), ...v]);
      out.push(merged);
      if (out.length > MAX_BRANCHES) {
        throw new CastellanError(`Condition expands to more than ${MAX_BRANCHES} branches; use scopeQuery instead`);
      }
    }
  }
  return out;
}

/** Converts a resolved tree to disjunctive normal form. */
function toDnf(node: ResolvedNode): Conjunction[] {
  switch (node.kind) {
    case 'const':
      return node.value ? [new Map()] : [];
    case 'or':
      return node.nodes.flatMap((n) => toDnf(n));
    case 'and':
      return node.nodes.reduce<Conjunction[]>((acc, n) => product(acc, toDnf(n)), [new Map()]);
    case 'not':
      throw new CastellanError('toFindOptionsWhere cannot express deny rules (NOT …); use scopeQuery / applyScope');
    case 'field': {
      const value = leaf(node);
      if (value === NEVER) return [];
      if (value === ALWAYS) return [new Map()];
      return [new Map([[node.field, [value]]])];
    }
  }
}

function toWhere(conjunction: Conjunction): Record<string, unknown> {
  const where: Record<string, unknown> = {};
  for (const [field, leaves] of conjunction) {
    const value =
      leaves.length === 1 ? leaves[0] : And(...leaves.map((l) => (l instanceof FindOperator ? l : Equal(l))));
    const [head, tail] = field.split('.') as [string, string | undefined];
    if (tail === undefined) {
      where[head] = value;
    } else {
      where[head] = { ...((where[head] as object) ?? {}), [tail]: value };
    }
  }
  return where;
}

/**
 * Converts the ability's scope into a `FindOptionsWhere` array for the repository API
 * (`repo.find({ where })`). Returns `null` when nothing is accessible — skip the query.
 *
 * `FindOptionsWhere` cannot express `NOT (a OR b)`, so scopes with deny rules throw;
 * use `scopeQuery` / `applyScope` for those.
 */
export function toFindOptionsWhere<T>(
  ability: Pick<Ability<string>, 'resolveScope'>,
  action: string,
  subjectType: SubjectType,
): FindOptionsWhere<T>[] | null {
  const resolved = ability.resolveScope(action, subjectType);
  assertResolvedScope(resolved);
  if (resolved.kind === 'none') return null;
  const branches = toDnf(resolved.node);
  if (!branches.length) return null;
  if (branches.some((b) => b.size === 0)) return [{} as FindOptionsWhere<T>];
  return branches.map((b) => toWhere(b) as FindOptionsWhere<T>);
}
