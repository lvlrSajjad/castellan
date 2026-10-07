import {
  type ConditionNode,
  evaluateCondition,
  normalizeConditions,
  reviveConditions,
} from './conditions.js';
import { CastellanError, UnresolvedRefError } from './errors.js';

/** Action alias that matches every action. */
export const MANAGE = 'manage';
/** Subject alias that matches every subject type. */
export const ALL = 'all';
/** Principal and domain wildcard. */
export const ANY = '*';

export type Effect = 'allow' | 'deny';

/** Where a stored policy came from. `code` rows are owned by `syncPolicies`. */
export type RuleOrigin = 'code' | 'runtime';

/**
 * A single authorization rule, in the form stored in Casbin.
 *
 * Naming: `principal` is *who* (a user id, a role, or `*`); `subject` is the CASL-style
 * resource type (`WorkOrder`, or `all`).
 */
export interface Rule {
  principal: string;
  domain: string;
  action: string;
  subject: string;
  effect: Effect;
  /** JSON-safe condition object (refs as `{ $ref }`, dates as `{ $date }`). */
  conditions?: Record<string, unknown>;
  fields?: string[];
  reason?: string;
  origin?: RuleOrigin;
}

/** Casbin policy row: `[sub, dom, obj, act, cond, eft]` (no `dom` when domains are disabled). */
export type PolicyRow = string[];

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/** Canonical (key-sorted) JSON, so identical rules always produce identical rows. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

/** Encodes the `cond` column: conditions plus `__fields` / `__reason` / `__origin` metadata. */
export function encodeCond(rule: Pick<Rule, 'conditions' | 'fields' | 'reason' | 'origin'>): string {
  const payload: Record<string, unknown> = { ...(rule.conditions ?? {}) };
  if (rule.fields?.length) payload.__fields = [...rule.fields].sort();
  if (rule.reason) payload.__reason = rule.reason;
  if (rule.origin) payload.__origin = rule.origin;
  return canonicalJson(payload);
}

/** Converts a rule to a Casbin policy row. */
export function ruleToRow(rule: Rule, domains: boolean): PolicyRow {
  const cond = encodeCond(rule);
  return domains
    ? [rule.principal, rule.domain, rule.subject, rule.action, cond, rule.effect]
    : [rule.principal, rule.subject, rule.action, cond, rule.effect];
}

/** Parsed form of the `cond` column, cached by its string value. */
export interface CompiledCond {
  conditions?: Record<string, unknown>;
  node?: ConditionNode;
  fields?: string[];
  reason?: string;
  origin?: RuleOrigin;
}

const condCache = new Map<string, CompiledCond>();
const COND_CACHE_LIMIT = 10_000;

/** Parses and validates a `cond` column value. Results are memoized. */
export function compileCond(cond: string): CompiledCond {
  const cached = condCache.get(cond);
  if (cached) return cached;
  let raw: Record<string, unknown>;
  try {
    raw = cond ? (JSON.parse(cond) as Record<string, unknown>) : {};
  } catch {
    throw new CastellanError(`Invalid cond JSON in policy: ${cond}`);
  }
  const { __fields, __reason, __origin, ...conditions } = raw;
  const compiled: CompiledCond = {};
  if (Object.keys(conditions).length) {
    compiled.conditions = conditions;
    compiled.node = normalizeConditions(reviveConditions(conditions));
  }
  if (Array.isArray(__fields) && __fields.length) compiled.fields = __fields as string[];
  if (typeof __reason === 'string') compiled.reason = __reason;
  if (__origin === 'code' || __origin === 'runtime') compiled.origin = __origin;
  if (condCache.size >= COND_CACHE_LIMIT) condCache.clear();
  condCache.set(cond, compiled);
  return compiled;
}

/** Converts a Casbin policy row back to a rule. */
export function rowToRule(row: PolicyRow, domains: boolean): Rule {
  const [principal, domain, subject, action, cond, effect] = domains
    ? row
    : [row[0], ANY, row[1], row[2], row[3], row[4]];
  if (!principal || !subject || !action || (effect !== 'allow' && effect !== 'deny')) {
    throw new CastellanError(`Malformed policy row: ${JSON.stringify(row)}`);
  }
  const compiled = compileCond(cond ?? '');
  const rule: Rule = { principal, domain: domain ?? ANY, action, subject, effect };
  if (compiled.conditions) rule.conditions = compiled.conditions;
  if (compiled.fields) rule.fields = compiled.fields;
  if (compiled.reason) rule.reason = compiled.reason;
  if (compiled.origin) rule.origin = compiled.origin;
  return rule;
}

/**
 * The object passed as `r.obj` to the Casbin enforcer.
 * Built by castellan; never construct it by hand.
 */
export interface RequestObject {
  /** Subject type name, e.g. `WorkOrder`. */
  type: string;
  /** The instance being checked; omitted for type-level checks (`can('read', WorkOrder)`). */
  data?: object;
  /** Field being checked, for field-level permissions. */
  field?: string;
  /** Attributes of the user, used to resolve `$ref`s. */
  user: unknown;
  /**
   * Scope predicate for instance checks in a scoped domain: the instance must belong to the
   * request's tenant (or, for subjects without a tenant column, to one of the domain's leaves).
   * Applied to allow rules only.
   */
  scope?: RequestScope;
}

/** Built by castellan from the subject map; values are compared as strings. */
export interface RequestScope {
  /** The tenant column equals the domain's tenant value. */
  tenant?: { field: string; value: string };
  /** The tenant link column is in a per-domain list (`tenant: { field, in }`). */
  tenantIn?: { field: string; set: ReadonlySet<string> };
  /** No tenant link: the leaf column is one of the domain's leaves. */
  leaves?: { field: string; set: ReadonlySet<string> };
}

/** True when `data` satisfies the request's tenant / domain-leaf predicate. Nullish values never match. */
export function requestScopeMatches(scope: RequestScope, data: object): boolean {
  if (scope.tenant) {
    const value = (data as Record<string, unknown>)[scope.tenant.field];
    if (value === null || value === undefined || String(value) !== scope.tenant.value) return false;
  }
  for (const member of [scope.tenantIn, scope.leaves]) {
    if (!member) continue;
    const value = (data as Record<string, unknown>)[member.field];
    if (value === null || value === undefined || !member.set.has(String(value))) return false;
  }
  return true;
}

/** `actionMatch(r.act, p.act)` — `manage` matches every action. */
export function actionMatches(requested: string, ruleAction: string): boolean {
  return ruleAction === MANAGE || ruleAction === requested;
}

/** `subjectMatch(r.obj, p.obj)` — `all` matches every subject type. */
export function subjectMatches(requested: string, ruleSubject: string): boolean {
  return ruleSubject === ALL || ruleSubject === requested;
}

/**
 * `condMatch(r.obj, p.cond, p.eft)` — the single source of truth for conditions and fields,
 * used by both the in-memory ability and the Casbin matcher.
 *
 * - Type-level checks (no `data`): conditional allow rules match, conditional deny rules do not (CASL semantics).
 * - Field rules: when no field is requested, allow rules match and deny rules do not (CASL semantics).
 * - Unresolved `$ref`: fail closed — allow rules do not match, deny rules do.
 * - Scoped domains: allow rules only match instances inside the request's tenant ({@link RequestScope}).
 */
export function condMatches(request: RequestObject, cond: CompiledCond, effect: Effect): boolean {
  if (cond.fields) {
    if (request.field === undefined) {
      if (effect === 'deny') return false;
    } else if (!cond.fields.includes(request.field)) {
      return false;
    }
  }
  if (effect === 'allow' && request.scope && request.data !== undefined && !requestScopeMatches(request.scope, request.data)) {
    return false;
  }
  if (!cond.node) return true;
  if (request.data === undefined) return effect === 'allow';
  try {
    return evaluateCondition(cond.node, request.data, request.user);
  } catch (error) {
    if (error instanceof UnresolvedRefError) return effect === 'deny';
    throw error;
  }
}
