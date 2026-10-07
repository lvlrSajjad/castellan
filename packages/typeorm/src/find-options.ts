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
/** A conjunction of field constraints; `false` marks an impossible branch. */
type Conjunction = Map<string, Leaf[]> | false;

/** Leaf that can never match (e.g. `$in: []`). */
const NEVER = Symbol('never');
/** Leaf that always matches (e.g. `$nin: []`). */
const ALWAYS = Symbol('always');

const MAX_BRANCHES = 64;

function leaf(node: Extract<ConditionNode, { kind: 'field' }>, user: unknown): Leaf | typeof NEVER | typeof ALWAYS {
  switch (node.op) {
    case '$exists':
      return (node.operand as { value: boolean }).value ? Not(IsNull()) : IsNull();
    case '$eq': {
      const v = resolveOperand(node.operand as Operand, user);
      return v === null ? IsNull() : v;
    }
    case '$ne': {
      const v = resolveOperand(node.operand as Operand, user);
      return v === null ? Not(IsNull()) : Or(Not(v), IsNull());
    }
    case '$in': {
      const list = resolveList(node.operand, user);
      const values = list.filter((v) => v !== null && v !== undefined);
      const hasNull = values.length !== list.length;
      if (!values.length) return hasNull ? IsNull() : NEVER;
      return hasNull ? Or(In(values), IsNull()) : In(values);
    }
    case '$nin': {
      const list = resolveList(node.operand, user);
      const values = list.filter((v) => v !== null && v !== undefined);
      const hasNull = values.length !== list.length;
      if (!values.length) return hasNull ? Not(IsNull()) : ALWAYS;
      return hasNull ? And(Not(In(values)), Not(IsNull())) : Or(Not(In(values)), IsNull());
    }
    default: {
      const v = resolveOperand(node.operand as Operand, user);
      if (v === null) return NEVER;
      return { $gt: MoreThan, $gte: MoreThanOrEqual, $lt: LessThan, $lte: LessThanOrEqual }[node.op](v);
    }
  }
}

function product(a: Conjunction[], b: Conjunction[]): Conjunction[] {
  const out: Conjunction[] = [];
  for (const x of a) {
    for (const y of b) {
      if (x === false || y === false) continue;
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

/** Converts a condition tree to disjunctive normal form. */
function toDnf(node: ConditionNode, user: unknown): Conjunction[] {
  if (node.kind === 'or') return node.nodes.flatMap((n) => toDnf(n, user)).filter((c) => c !== false);
  if (node.kind === 'and') return node.nodes.reduce<Conjunction[]>((acc, n) => product(acc, toDnf(n, user)), [new Map()]);
  const value = leaf(node, user);
  if (value === NEVER) return [];
  if (value === ALWAYS) return [new Map()];
  return [new Map([[node.field, [value]]])];
}

function toWhere(conjunction: Map<string, Leaf[]>): Record<string, unknown> {
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

function ruleDnf(rule: Rule, user: unknown): Conjunction[] {
  if (!rule.conditions) return [new Map()];
  try {
    return toDnf(normalizeConditions(reviveConditions(rule.conditions)), user);
  } catch (error) {
    if (error instanceof UnresolvedRefError) return [];
    throw error;
  }
}

/**
 * Converts the ability's rules into a `FindOptionsWhere` array for the repository API
 * (`repo.find({ where })`). Returns `null` when nothing is accessible — skip the query.
 *
 * `FindOptionsWhere` cannot express `NOT (a OR b)`, so conditional deny rules throw;
 * use {@link scopeQuery} for those.
 */
export function toFindOptionsWhere<T>(
  ability: Ability<string>,
  action: string,
  subjectType: SubjectType,
): FindOptionsWhere<T>[] | null {
  const { allow, deny } = ability.rulesFor(action, subjectType);
  if (deny.some((r) => !r.conditions)) return null;
  if (deny.length) {
    throw new CastellanError(
      `toFindOptionsWhere cannot express conditional deny rules (${deny.length} apply to ${action}); use scopeQuery`,
    );
  }
  const branches = allow.flatMap((r) => ruleDnf(r, ability.user)).filter((c): c is Map<string, Leaf[]> => c !== false);
  if (!branches.length) return null;
  if (branches.some((b) => b.size === 0)) return [{} as FindOptionsWhere<T>];
  return branches.map((b) => toWhere(b) as FindOptionsWhere<T>);
}
