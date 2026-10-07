import { ConditionError, UnresolvedRefError } from './errors.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

declare const refType: unique symbol;

/**
 * A reference to an attribute of the user being authorized, resolved at check time.
 * Created by accessing properties on the `user` proxy passed to `definePolicies`.
 * Serialized as `{ "$ref": "user.siteIds" }`.
 */
export interface Ref<T = unknown> {
  readonly $ref: string;
  readonly [refType]?: T;
}

type Scalar = string | number | boolean | bigint | Date | null | undefined;

/**
 * Typed proxy over the user object. Every property access returns a {@link Ref}.
 * `user.id` → `{ $ref: 'user.id' }`, `user.org.id` → `{ $ref: 'user.org.id' }`.
 */
export type Refs<U> = {
  readonly [K in keyof U]-?: Ref<U[K]> &
    (NonNullable<U[K]> extends Scalar | readonly unknown[] | ((...args: never[]) => unknown)
      ? unknown
      : Refs<NonNullable<U[K]>>);
};

type Value<V> = V | Ref<V> | Ref<V | null | undefined>;

/** Operators allowed on a single field. */
export interface FieldOperators<V> {
  $eq?: Value<V | null>;
  $ne?: Value<V | null>;
  $in?: ReadonlyArray<Value<V> | null> | Ref<ReadonlyArray<V>> | Ref<ReadonlyArray<V> | undefined>;
  $nin?: ReadonlyArray<Value<V> | null> | Ref<ReadonlyArray<V>> | Ref<ReadonlyArray<V> | undefined>;
  $gt?: Value<V>;
  $gte?: Value<V>;
  $lt?: Value<V>;
  $lte?: Value<V>;
  $exists?: boolean;
}

/** Condition on one field: an implicit `$eq` value or an operator object. */
export type FieldCondition<V> = Value<V> | null | FieldOperators<V>;

type FieldKeys<T> = {
  [K in keyof T & string]: T[K] extends (...args: never[]) => unknown ? never : K;
}[keyof T & string];

type NestedKeys<T> = {
  [K in FieldKeys<T>]: NonNullable<T[K]> extends Scalar | readonly unknown[]
    ? never
    : NonNullable<T[K]> extends object
      ? `${K}.${FieldKeys<NonNullable<T[K]>>}`
      : never;
}[FieldKeys<T>];

type PathValue<T, P extends string> = P extends `${infer A}.${infer B}`
  ? A extends keyof T
    ? B extends keyof NonNullable<T[A]>
      ? NonNullable<T[A]>[B]
      : never
    : never
  : P extends keyof T
    ? T[P]
    : never;

/**
 * Mongo-style condition object typed against the subject's fields.
 * Supports root fields and one level of dotted relation paths (`site.region`).
 */
export type Conditions<T = Record<string, unknown>> = {
  [P in FieldKeys<T> | NestedKeys<T>]?: FieldCondition<NonNullable<PathValue<T, P>>>;
} & {
  $and?: ReadonlyArray<Conditions<T>>;
  $or?: ReadonlyArray<Conditions<T>>;
};

// ---------------------------------------------------------------------------
// Normalized AST
// ---------------------------------------------------------------------------

export type FieldOperator = '$eq' | '$ne' | '$in' | '$nin' | '$gt' | '$gte' | '$lt' | '$lte' | '$exists';

/** A literal value or a `$ref` to a user attribute. */
export type Operand = { ref: string } | { value: unknown };

/** Normalized condition tree shared by the evaluator and the query builders. */
export type ConditionNode =
  | { kind: 'and'; nodes: ConditionNode[] }
  | { kind: 'or'; nodes: ConditionNode[] }
  | { kind: 'field'; field: string; op: FieldOperator; operand: Operand | Operand[] };

const FIELD_OPERATORS = new Set<string>(['$eq', '$ne', '$in', '$nin', '$gt', '$gte', '$lt', '$lte', '$exists']);
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;
const REF_PATH = /^user(\.[A-Za-z_$][A-Za-z0-9_$]*)+$/;

// ---------------------------------------------------------------------------
// Refs
// ---------------------------------------------------------------------------

/** True when `value` is a `$ref` token (plain object or `user` proxy). */
export function isRef(value: unknown): value is Ref {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false;
  const ref = (value as { $ref?: unknown }).$ref;
  return typeof ref === 'string';
}

/** Creates a `$ref` token by path, e.g. `ref('user.id')`. Prefer the typed `user` proxy. */
export function ref<T = unknown>(path: string): Ref<T> {
  if (!REF_PATH.test(path)) throw new ConditionError(`Invalid $ref path "${path}" (expected "user.<attribute>")`);
  return { $ref: path } as Ref<T>;
}

const STATIC_POLICY_HINT =
  'Policies are static and synced to Casbin, so they cannot branch on or compute with user values. ' +
  'Reference attributes directly (`{ assigneeId: user.id }`) and use role(...) blocks instead of `if` checks.';

/** Builds the `user` proxy handed to `definePolicies`. */
export function createRefProxy<U>(path = 'user'): Refs<U> {
  const target = function refProxy() {};
  return new Proxy(target, {
    get(_, prop) {
      if (prop === '$ref') return path;
      if (prop === 'toJSON') return () => ({ $ref: path });
      if (prop === Symbol.toPrimitive || prop === 'toString' || prop === 'valueOf') {
        return () => {
          throw new ConditionError(`Cannot convert ${path} to a primitive. ${STATIC_POLICY_HINT}`);
        };
      }
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      return createRefProxy(`${path}.${prop}`);
    },
    apply() {
      throw new ConditionError(`${path} is not callable. ${STATIC_POLICY_HINT}`);
    },
    has() {
      throw new ConditionError(`Cannot use "in" on ${path}. ${STATIC_POLICY_HINT}`);
    },
  }) as unknown as Refs<U>;
}

// ---------------------------------------------------------------------------
// Normalization / validation
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function toOperand(value: unknown, where: string): Operand {
  if (isRef(value)) {
    const path = value.$ref;
    if (!REF_PATH.test(path)) throw new ConditionError(`Invalid $ref path "${path}" at ${where}`);
    return { ref: path };
  }
  if (value === undefined) throw new ConditionError(`Undefined value at ${where}`);
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new ConditionError(`Unsupported value type "${typeof value}" at ${where}`);
  }
  if (Array.isArray(value)) throw new ConditionError(`Arrays are only allowed with $in/$nin (at ${where})`);
  if (isPlainObject(value)) throw new ConditionError(`Unexpected object at ${where}; did you mean an operator?`);
  return { value };
}

function normalizeField(field: string, raw: unknown): ConditionNode {
  if (!FIELD_NAME.test(field)) {
    throw new ConditionError(
      `Invalid field "${field}". Fields must be identifiers, with at most one dotted relation level (e.g. "site.region").`,
    );
  }
  if (!isPlainObject(raw) || isRef(raw)) {
    return { kind: 'field', field, op: '$eq', operand: toOperand(raw, field) };
  }
  const entries = Object.entries(raw);
  if (entries.length === 0) throw new ConditionError(`Empty operator object for field "${field}"`);
  const nodes: ConditionNode[] = entries.map(([op, value]) => {
    if (!FIELD_OPERATORS.has(op)) {
      throw new ConditionError(
        `Unsupported operator "${op}" on field "${field}". Supported: ${[...FIELD_OPERATORS].join(', ')}`,
      );
    }
    const where = `${field}.${op}`;
    if (op === '$exists') {
      if (typeof value !== 'boolean') throw new ConditionError(`${where} expects a boolean`);
      return { kind: 'field', field, op: '$exists', operand: { value } };
    }
    if (op === '$in' || op === '$nin') {
      if (isRef(value)) return { kind: 'field', field, op, operand: toOperand(value, where) };
      if (!Array.isArray(value)) throw new ConditionError(`${where} expects an array or a $ref`);
      return { kind: 'field', field, op, operand: value.map((v, i) => toOperand(v, `${where}[${i}]`)) };
    }
    return { kind: 'field', field, op: op as FieldOperator, operand: toOperand(value, where) };
  });
  return nodes.length === 1 ? nodes[0]! : { kind: 'and', nodes };
}

/**
 * Validates a condition object against the v1 operator whitelist and converts it to a {@link ConditionNode}.
 * Throws {@link ConditionError} on anything unsupported (`$regex`, `$elemMatch`, deep paths, `__`-prefixed keys…).
 */
export function normalizeConditions(conditions: unknown): ConditionNode {
  if (!isPlainObject(conditions)) throw new ConditionError('Conditions must be a plain object');
  const nodes: ConditionNode[] = [];
  for (const [key, value] of Object.entries(conditions)) {
    if (value === undefined) continue;
    if (key === '$and' || key === '$or') {
      if (!Array.isArray(value) || value.length === 0) {
        throw new ConditionError(`${key} expects a non-empty array of condition objects`);
      }
      nodes.push({ kind: key === '$and' ? 'and' : 'or', nodes: value.map((c) => normalizeConditions(c)) });
    } else if (key.startsWith('$')) {
      throw new ConditionError(`Unsupported top-level operator "${key}". Supported: $and, $or`);
    } else if (key.startsWith('__')) {
      throw new ConditionError(`Field names starting with "__" are reserved (got "${key}")`);
    } else {
      nodes.push(normalizeField(key, value));
    }
  }
  return nodes.length === 1 ? nodes[0]! : { kind: 'and', nodes };
}

/** Converts a condition object (possibly holding `user` proxies) into plain JSON-safe data. */
export function serializeConditions(conditions: unknown): Record<string, unknown> {
  normalizeConditions(conditions);
  return toJsonValue(conditions) as Record<string, unknown>;
}

function toJsonValue(value: unknown): unknown {
  if (isRef(value)) return { $ref: value.$ref };
  if (value instanceof Date) return { $date: value.toISOString() };
  if (typeof value === 'bigint') throw new ConditionError('bigint values cannot be stored in policies; use strings');
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, toJsonValue(v)]),
    );
  }
  return value;
}

/** Reverses the JSON encoding used by {@link serializeConditions} (revives `{ $date }`). */
export function reviveConditions(json: unknown): unknown {
  if (Array.isArray(json)) return json.map(reviveConditions);
  if (isPlainObject(json)) {
    const keys = Object.keys(json);
    if (keys.length === 1 && keys[0] === '$date' && typeof json.$date === 'string') return new Date(json.$date);
    return Object.fromEntries(Object.entries(json).map(([k, v]) => [k, reviveConditions(v)]));
  }
  return json;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/** Resolves a `$ref` against the user attributes. Throws {@link UnresolvedRefError} when undefined. */
export function resolveRef(path: string, user: unknown): unknown {
  let current: unknown = user;
  for (const part of path.split('.').slice(1)) {
    if (current === null || current === undefined) break;
    current = (current as Record<string, unknown>)[part];
  }
  if (current === undefined) throw new UnresolvedRefError(path);
  return current;
}

/** Resolves an operand to a concrete value. */
export function resolveOperand(operand: Operand, user: unknown): unknown {
  return 'ref' in operand ? resolveRef(operand.ref, user) : operand.value;
}

/** Resolves the operand list of `$in` / `$nin` (an inline array or a `$ref` to an array). */
export function resolveList(operand: Operand | Operand[], user: unknown): unknown[] {
  if (Array.isArray(operand)) return operand.map((o) => resolveOperand(o, user));
  const value = resolveOperand(operand, user);
  if (!Array.isArray(value)) {
    throw new ConditionError(`$in/$nin reference ${'ref' in operand ? operand.ref : ''} did not resolve to an array`);
  }
  return value;
}

function readPath(data: unknown, field: string): unknown {
  let current = data;
  for (const part of field.split('.')) {
    if (current === null || current === undefined) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function comparable(value: unknown): unknown {
  return value instanceof Date ? value.getTime() : value;
}

function isNullish(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}

/** Equality with SQL-like null handling: `null` equals only `null`/`undefined`, Dates compare by time. */
export function valuesEqual(a: unknown, b: unknown): boolean {
  if (isNullish(a) || isNullish(b)) return isNullish(a) && isNullish(b);
  return comparable(a) === comparable(b);
}

function compare(fieldValue: unknown, operand: unknown, op: '$gt' | '$gte' | '$lt' | '$lte'): boolean {
  // Comparisons against null never match, mirroring SQL.
  if (isNullish(fieldValue) || isNullish(operand)) return false;
  const a = comparable(fieldValue) as number | string;
  const b = comparable(operand) as number | string;
  if (typeof a !== typeof b) return false;
  switch (op) {
    case '$gt':
      return a > b;
    case '$gte':
      return a >= b;
    case '$lt':
      return a < b;
    case '$lte':
      return a <= b;
  }
}

/**
 * Evaluates a normalized condition against a data object.
 * Semantics are chosen to match the SQL generated by the TypeORM query scoper
 * (`$ne`/`$nin` match nulls, comparisons with null never match, `$exists` means "not null").
 * Throws {@link UnresolvedRefError} if a `$ref` is undefined; callers decide the fail-closed outcome.
 */
export function evaluateCondition(node: ConditionNode, data: unknown, user: unknown): boolean {
  switch (node.kind) {
    case 'and':
      return node.nodes.every((n) => evaluateCondition(n, data, user));
    case 'or':
      return node.nodes.some((n) => evaluateCondition(n, data, user));
    case 'field': {
      const fieldValue = readPath(data, node.field);
      switch (node.op) {
        case '$exists':
          return (node.operand as { value: boolean }).value === !isNullish(fieldValue);
        case '$in':
          return resolveList(node.operand, user).some((v) => valuesEqual(fieldValue, v));
        case '$nin':
          return !resolveList(node.operand, user).some((v) => valuesEqual(fieldValue, v));
        case '$eq':
          return valuesEqual(fieldValue, resolveOperand(node.operand as Operand, user));
        case '$ne':
          return !valuesEqual(fieldValue, resolveOperand(node.operand as Operand, user));
        default:
          return compare(fieldValue, resolveOperand(node.operand as Operand, user), node.op);
      }
    }
  }
}
