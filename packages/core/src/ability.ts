import {
  ANY,
  type CompiledCond,
  type Effect,
  type RequestObject,
  type RequestScope,
  type Rule,
  actionMatches,
  compileCond,
  condMatches,
  encodeCond,
  subjectMatches,
} from './rule.js';
import { CastellanError, ScopeMappingError } from './errors.js';
import { type GrantIssue, type ReachEntry } from './grants.js';
import {
  type ResolvedNode,
  type ResolvedScope,
  FALSE_NODE,
  TRUE_NODE,
  andNode,
  fieldNode,
  notNode,
  orNode,
  resolveConditions,
} from './resolve.js';
import { type ScopeTree, type SubjectMap, leafSet, requireSubjectScope } from './scope.js';
import { type AnyClass, type DetectSubjectType, type SubjectType, resolveSubject } from './subject.js';

/** Result of {@link Ability.explain}. */
export interface Explanation {
  allowed: boolean;
  /** The rule that decided: the first matching deny, else the first matching allow, else none. */
  decidingRule?: Rule;
  matchedAllows: Rule[];
  matchedDenies: Rule[];
  /** Human-readable summary. */
  message: string;
}

export interface AbilityOptions {
  /** The user object `$ref`s resolve against (`user.id` → `attributes.id`). */
  user?: unknown;
  detectSubjectType?: DetectSubjectType;
  /** Domain the rules were loaded for (informational). */
  domain?: string;
  /** Scope context for scoped domains (external grants mode). */
  scope?: AbilityScope;
}

/**
 * Scope context of an ability built for a scoped domain. Every allow rule is limited to the
 * request's tenant and to the scopes through which its role reaches the domain.
 */
export interface AbilityScope {
  /** The request domain, a scope key such as `'org:812'`. */
  domain: string;
  subjects: SubjectMap;
  tree?: ScopeTree;
  /** Role key → scopes through which it reaches the domain. Rules of keys without reach never apply. */
  reach?: ReadonlyMap<string, readonly ReachEntry[]>;
  /** Largest leaf list castellan will expand. Default 5 000. */
  maxScopeLeaves?: number;
  /** Earliest instant at which an assignment starts or stops (epoch ms). */
  expiresAt?: number;
  /** Things skipped while building (unknown roles, …). */
  issues?: readonly GrantIssue[];
}

const DEFAULT_MAX_SCOPE_LEAVES = 5_000;

interface CompiledRule {
  rule: Rule;
  cond: CompiledCond;
}

type SubjectArg = SubjectType | object;

/**
 * In-memory permission checker with a CASL-shaped API.
 *
 * Holds the rules that apply to one user (in one domain) and evaluates them with the same
 * `condMatch` logic registered on the Casbin enforcer, so `ability.can()` and `enforcer.enforce()`
 * always agree. Precedence follows Casbin: any matching deny wins, order does not matter.
 */
export class Ability<A extends string = string> {
  readonly rules: readonly Rule[];
  readonly user: unknown;
  readonly domain?: string;
  /** Scope context, when the ability was built for a scoped domain. */
  readonly scope?: AbilityScope;
  private readonly compiled: CompiledRule[];
  private readonly detect?: DetectSubjectType;
  private readonly leafCache = new Map<string, Set<string>>();

  constructor(rules: readonly Rule[], options: AbilityOptions = {}) {
    this.rules = rules;
    this.user = options.user;
    this.scope = options.scope;
    this.domain = options.domain ?? options.scope?.domain;
    this.detect = options.detectSubjectType;
    this.compiled = rules.map((rule) => ({ rule, cond: compileCond(encodeCond(rule)) }));
  }

  /** Earliest instant (epoch ms) at which this ability goes stale because an assignment starts or ends. */
  get expiresAt(): number | undefined {
    return this.scope?.expiresAt;
  }

  /**
   * Checks whether `action` is allowed on a subject type or instance.
   * @example ability.can('update', workOrder); ability.can('read', WorkOrder); ability.can('read', user, 'email')
   */
  can(action: A | 'manage', subject: SubjectArg, field?: string): boolean {
    return this.explain(action, subject, field).allowed;
  }

  /** Negation of {@link can}. */
  cannot(action: A | 'manage', subject: SubjectArg, field?: string): boolean {
    return !this.can(action, subject, field);
  }

  /** The rule that decided the outcome (deny first), e.g. to read its `reason`. */
  relevantRuleFor(action: A | 'manage', subject: SubjectArg, field?: string): Rule | undefined {
    return this.explain(action, subject, field).decidingRule;
  }

  /** Explains a decision: which rules matched and which one decided. */
  explain(action: A | 'manage', subject: SubjectArg, field?: string): Explanation {
    const { type, data } = resolveSubject(subject, this.detect);
    const request: RequestObject = { type, data, field, user: this.user };
    if (this.scope) {
      requireSubjectScope(this.scope.subjects, type);
      if (data !== undefined) request.scope = this.requestScope(type);
    }
    const matchedAllows: Rule[] = [];
    const matchedDenies: Rule[] = [];
    for (const { rule, cond } of this.compiled) {
      if (!actionMatches(action, rule.action) || !subjectMatches(type, rule.subject)) continue;
      if (rule.effect === 'allow' && !this.reaches(rule, type, data)) continue;
      if (!condMatches(request, cond, rule.effect)) continue;
      (rule.effect === 'deny' ? matchedDenies : matchedAllows).push(rule);
    }
    const allowed = matchedDenies.length === 0 && matchedAllows.length > 0;
    const decidingRule = matchedDenies[0] ?? matchedAllows[0];
    const target = `${action} ${type}${field ? `.${field}` : ''}`;
    const message = allowed
      ? `Allowed: ${target}`
      : matchedDenies.length
        ? `Denied: ${target}${decidingRule?.reason ? ` (${decidingRule.reason})` : ''}`
        : `Denied: no rule allows ${target}`;
    return { allowed, decidingRule, matchedAllows, matchedDenies, message };
  }

  /**
   * Rules relevant to an action on a subject type, split by effect. Used by query scopers to
   * build `WHERE (allow1 OR …) AND NOT (deny1 OR …)`. Field-restricted deny rules are excluded,
   * since they do not restrict whole rows.
   */
  rulesFor(action: A | 'manage', subjectType: SubjectType): Record<Effect, Rule[]> {
    const type = resolveSubject(subjectType).type;
    const result: Record<Effect, Rule[]> = { allow: [], deny: [] };
    for (const { rule } of this.compiled) {
      if (!actionMatches(action, rule.action) || !subjectMatches(type, rule.subject)) continue;
      if (rule.effect === 'deny' && rule.fields) continue;
      if (rule.effect === 'allow' && !this.reaches(rule, type, undefined)) continue;
      result[rule.effect].push(rule);
    }
    return result;
  }

  /**
   * Resolves the row filter for `action` on a subject type: `none`, or a condition with every
   * `$ref`, tenant and scope predicate resolved to literal values. Database-agnostic; pass the
   * result to `applyScope` (`@castellan/typeorm`) or inspect it in tests.
   *
   * In a scoped domain every allowed branch carries the tenant (or leaf) predicate, so the result
   * can never be "all rows".
   */
  resolveScope(action: A | 'manage', subjectType: SubjectType): ResolvedScope {
    const type = resolveSubject(subjectType).type;
    const { allow, deny } = this.rulesFor(action, type);
    const allowNodes = allow.map((rule) =>
      andNode([this.scopePredicate(rule, type), resolveConditions(rule.conditions, this.user, 'allow')]),
    );
    const denyNodes = deny.map((rule) => resolveConditions(rule.conditions, this.user, 'deny'));
    const node = andNode([orNode(allowNodes), notNode(orNode(denyNodes))]);
    if (node.kind === 'const' && !node.value) return { kind: 'none' };
    if (this.scope && node.kind === 'const') {
      throw new CastellanError(`Invariant violated: scoped ${action} ${type} resolved to an unrestricted filter`);
    }
    return { kind: 'condition', node };
  }

  /** Whether an allow rule's role reaches the domain (and, for instances, the instance's leaf). */
  private reaches(rule: Rule, type: string, data: object | undefined): boolean {
    const reach = this.scope?.reach;
    if (!reach) return true;
    const entries = reach.get(rule.principal);
    if (!entries?.length) return false;
    if (data === undefined || entries.some((e) => e.covers)) return true;
    const leaf = requireSubjectScope(this.scope!.subjects, type).leaf;
    if (!leaf) return false;
    const value = (data as Record<string, unknown>)[leaf];
    if (value === null || value === undefined) return false;
    return entries.some((e) => this.leaves(e.scope).has(String(value)));
  }

  /** The tenant / domain-leaf predicate for instance checks, shared with the Casbin matcher. */
  requestScope(type: string): RequestScope {
    const scope = this.scope!;
    const map = requireSubjectScope(scope.subjects, type);
    if (map.tenant) return { tenant: { field: map.tenant, value: String(scope.subjects.tenantValue(scope.domain)) } };
    return { leaves: { field: map.leaf!, set: this.leaves(scope.domain) } };
  }

  /** Tenant predicate AND reach predicate for one allow rule, as a resolved node. */
  private scopePredicate(rule: Rule, type: string): ResolvedNode {
    const scope = this.scope;
    if (!scope) return TRUE_NODE;
    const map = requireSubjectScope(scope.subjects, type);
    const tenant = map.tenant
      ? fieldNode(map.tenant, '$eq', scope.subjects.tenantValue(scope.domain))
      : fieldNode(map.leaf!, '$in', this.leafValues(scope.domain));
    const entries = scope.reach?.get(rule.principal);
    if (!scope.reach || entries?.some((e) => e.covers)) return tenant;
    if (!entries?.length || !map.leaf) return FALSE_NODE;
    const leaves = new Set<unknown>();
    for (const entry of entries) for (const id of this.leafValues(entry.scope)) leaves.add(id);
    return andNode([tenant, fieldNode(map.leaf, '$in', [...leaves])]);
  }

  private leaves(scopeKey: string): Set<string> {
    let set = this.leafCache.get(scopeKey);
    if (!set) {
      set = leafSet(this.requireTree(), scopeKey, this.scope?.maxScopeLeaves ?? DEFAULT_MAX_SCOPE_LEAVES);
      this.leafCache.set(scopeKey, set);
    }
    return set;
  }

  private leafValues(scopeKey: string): readonly unknown[] {
    this.leaves(scopeKey); // enforces maxScopeLeaves
    return this.requireTree().leaves(scopeKey);
  }

  private requireTree(): ScopeTree {
    if (!this.scope?.tree) throw new ScopeMappingError('This check needs leaf scopes, but the ability has no scope tree');
    return this.scope.tree;
  }

  /**
   * Fields the user may access: union of fields from matching allow rules minus fields from
   * matching deny rules. Allow rules without a field list grant `allFields` (required to resolve them).
   */
  permittedFieldsOf(action: A | 'manage', subject: SubjectArg, options: { allFields?: readonly string[] } = {}): string[] {
    const { type, data } = resolveSubject(subject, this.detect);
    const request: RequestObject = { type, data, user: this.user };
    if (this.scope) {
      requireSubjectScope(this.scope.subjects, type);
      if (data !== undefined) request.scope = this.requestScope(type);
    }
    const allowed = new Set<string>();
    const denied = new Set<string>();
    for (const { rule, cond } of this.compiled) {
      if (!actionMatches(action, rule.action) || !subjectMatches(type, rule.subject)) continue;
      if (rule.effect === 'allow' && !this.reaches(rule, type, data)) continue;
      // Evaluate conditions only; fields are handled here.
      if (!condMatches(request, { ...cond, fields: undefined }, rule.effect)) continue;
      if (rule.effect === 'allow') {
        const fields = rule.fields ?? options.allFields;
        if (!fields) {
          throw new CastellanError(`permittedFieldsOf: rule ${rule.action} ${rule.subject} has no field list; pass options.allFields`);
        }
        for (const f of fields) allowed.add(f);
      } else if (rule.fields) {
        for (const f of rule.fields) denied.add(f);
      } else {
        return [];
      }
    }
    return [...allowed].filter((f) => !denied.has(f));
  }
}

/** Creates an ability directly from rules (e.g. in tests or on the client). */
export function createAbility<A extends string = string>(rules: readonly Rule[], options?: AbilityOptions): Ability<A> {
  return new Ability<A>(rules, options);
}

/** Filters rules down to those for a set of principals and a domain. */
export function rulesForPrincipals(rules: readonly Rule[], principals: readonly string[], domain?: string): Rule[] {
  const set = new Set([...principals, ANY]);
  return rules.filter((r) => set.has(r.principal) && (domain === undefined || r.domain === ANY || r.domain === domain));
}

export type { AnyClass };
