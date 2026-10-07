import {
  type ConditionNode,
  type FieldOperator,
  type Operand,
  normalizeConditions,
  resolveList,
  resolveOperand,
  reviveConditions,
} from './conditions.js';
import { InvalidScopeError, UnresolvedRefError } from './errors.js';

/**
 * A condition tree with every `$ref` and scope resolved to literal values. Database-agnostic:
 * `@castellanjs/typeorm`'s `applyScope` writes it as SQL; apps can inspect or test it directly.
 */
export type ResolvedNode =
  | { kind: 'const'; value: boolean }
  | { kind: 'and'; nodes: ResolvedNode[] }
  | { kind: 'or'; nodes: ResolvedNode[] }
  | { kind: 'not'; node: ResolvedNode }
  | { kind: 'field'; field: string; op: FieldOperator; value: unknown };

/**
 * The row filter for one action on one subject type.
 *
 * - `none`: nothing allows it. Answer 403, or return no rows.
 * - `condition`: rows matching `node`. In a scoped domain the node always contains the tenant
 *   (or leaf) predicate, so it can never mean "all rows".
 */
export type ResolvedScope = { kind: 'none' } | { kind: 'condition'; node: ResolvedNode };

export const TRUE_NODE: ResolvedNode = { kind: 'const', value: true };
export const FALSE_NODE: ResolvedNode = { kind: 'const', value: false };

/** `AND` with constant folding. */
export function andNode(nodes: ResolvedNode[]): ResolvedNode {
  const out: ResolvedNode[] = [];
  for (const node of nodes) {
    if (node.kind === 'const') {
      if (!node.value) return FALSE_NODE;
      continue;
    }
    if (node.kind === 'and') out.push(...node.nodes);
    else out.push(node);
  }
  if (out.length === 0) return TRUE_NODE;
  return out.length === 1 ? out[0]! : { kind: 'and', nodes: out };
}

/** `OR` with constant folding. */
export function orNode(nodes: ResolvedNode[]): ResolvedNode {
  const out: ResolvedNode[] = [];
  for (const node of nodes) {
    if (node.kind === 'const') {
      if (node.value) return TRUE_NODE;
      continue;
    }
    if (node.kind === 'or') out.push(...node.nodes);
    else out.push(node);
  }
  if (out.length === 0) return FALSE_NODE;
  return out.length === 1 ? out[0]! : { kind: 'or', nodes: out };
}

/** `NOT` with constant folding. */
export function notNode(node: ResolvedNode): ResolvedNode {
  if (node.kind === 'const') return { kind: 'const', value: !node.value };
  if (node.kind === 'not') return node.node;
  return { kind: 'not', node };
}

/** A field predicate; `$in: []` folds to false and `$nin: []` to true. */
export function fieldNode(field: string, op: FieldOperator, value: unknown): ResolvedNode {
  if (op === '$in' && Array.isArray(value) && value.length === 0) return FALSE_NODE;
  if (op === '$nin' && Array.isArray(value) && value.length === 0) return TRUE_NODE;
  return { kind: 'field', field, op, value };
}

function resolveTree(node: ConditionNode, user: unknown): ResolvedNode {
  switch (node.kind) {
    case 'and':
      return andNode(node.nodes.map((n) => resolveTree(n, user)));
    case 'or':
      return orNode(node.nodes.map((n) => resolveTree(n, user)));
    case 'field':
      if (node.op === '$in' || node.op === '$nin') return fieldNode(node.field, node.op, resolveList(node.operand, user));
      return fieldNode(node.field, node.op, resolveOperand(node.operand as Operand, user));
  }
}

/**
 * Resolves a stored condition object against the user. An unresolved `$ref` fails closed:
 * `false` for allow rules, `true` for deny rules.
 */
export function resolveConditions(
  conditions: Record<string, unknown> | undefined,
  user: unknown,
  effect: 'allow' | 'deny',
): ResolvedNode {
  if (!conditions) return TRUE_NODE;
  try {
    return resolveTree(normalizeConditions(reviveConditions(conditions)), user);
  } catch (error) {
    if (error instanceof UnresolvedRefError) return { kind: 'const', value: effect === 'deny' };
    throw error;
  }
}

const OPERATORS = new Set(['$eq', '$ne', '$in', '$nin', '$gt', '$gte', '$lt', '$lte', '$exists']);

function assertNode(node: unknown, path: string): asserts node is ResolvedNode {
  if (!node || typeof node !== 'object') throw new InvalidScopeError(`Invalid scope node at ${path}`);
  const n = node as Record<string, unknown>;
  switch (n.kind) {
    case 'const':
      if (typeof n.value !== 'boolean') throw new InvalidScopeError(`Invalid const node at ${path}`);
      return;
    case 'and':
    case 'or':
      if (!Array.isArray(n.nodes) || n.nodes.length === 0) throw new InvalidScopeError(`Empty ${n.kind} node at ${path}`);
      n.nodes.forEach((child, i) => assertNode(child, `${path}.nodes[${i}]`));
      return;
    case 'not':
      assertNode(n.node, `${path}.node`);
      return;
    case 'field':
      if (typeof n.field !== 'string' || !n.field || !OPERATORS.has(n.op as string)) {
        throw new InvalidScopeError(`Invalid field node at ${path}`);
      }
      if ((n.op === '$in' || n.op === '$nin') && !Array.isArray(n.value)) {
        throw new InvalidScopeError(`${n.op as string} needs an array at ${path}`);
      }
      if (n.value === undefined) throw new InvalidScopeError(`Undefined value at ${path}`);
      return;
    default:
      throw new InvalidScopeError(`Unknown scope node kind at ${path}`);
  }
}

/**
 * Throws {@link InvalidScopeError} unless `value` is a well-formed {@link ResolvedScope}.
 * Every scope consumer calls this, so a bug that yields `undefined`, `null` or `{}` can never
 * turn into an unfiltered query.
 */
export function assertResolvedScope(value: unknown): asserts value is ResolvedScope {
  if (!value || typeof value !== 'object') throw new InvalidScopeError(`Expected a resolved scope, got ${String(value)}`);
  const scope = value as Record<string, unknown>;
  if (scope.kind === 'none') return;
  if (scope.kind !== 'condition') throw new InvalidScopeError('Resolved scope must have kind "none" or "condition"');
  assertNode(scope.node, 'node');
  if ((scope.node as ResolvedNode).kind === 'const' && !(scope.node as { value: boolean }).value) {
    throw new InvalidScopeError('A "condition" scope cannot be constant false; use { kind: "none" }');
  }
}

/**
 * Resolves the row filter for `action` on a subject type. Same as `ability.resolveScope(...)`,
 * validated with {@link assertResolvedScope} before it is returned.
 */
export function resolveScope(
  ability: { resolveScope(action: string, subjectType: unknown): ResolvedScope },
  action: string,
  subjectType: unknown,
): ResolvedScope {
  const scope = ability.resolveScope(action, subjectType);
  assertResolvedScope(scope);
  return scope;
}
