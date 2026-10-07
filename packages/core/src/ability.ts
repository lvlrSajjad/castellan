import {
  ANY,
  type CompiledCond,
  type Effect,
  type RequestObject,
  type Rule,
  actionMatches,
  compileCond,
  condMatches,
  encodeCond,
  subjectMatches,
} from './rule.js';
import { CastellanError } from './errors.js';
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
}

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
  private readonly compiled: CompiledRule[];
  private readonly detect?: DetectSubjectType;

  constructor(rules: readonly Rule[], options: AbilityOptions = {}) {
    this.rules = rules;
    this.user = options.user;
    this.domain = options.domain;
    this.detect = options.detectSubjectType;
    this.compiled = rules.map((rule) => ({ rule, cond: compileCond(encodeCond(rule)) }));
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
    const matchedAllows: Rule[] = [];
    const matchedDenies: Rule[] = [];
    for (const { rule, cond } of this.compiled) {
      if (!actionMatches(action, rule.action) || !subjectMatches(type, rule.subject)) continue;
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
      result[rule.effect].push(rule);
    }
    return result;
  }

  /**
   * Fields the user may access: union of fields from matching allow rules minus fields from
   * matching deny rules. Allow rules without a field list grant `allFields` (required to resolve them).
   */
  permittedFieldsOf(action: A | 'manage', subject: SubjectArg, options: { allFields?: readonly string[] } = {}): string[] {
    const { type, data } = resolveSubject(subject, this.detect);
    const request: RequestObject = { type, data, user: this.user };
    const allowed = new Set<string>();
    const denied = new Set<string>();
    for (const { rule, cond } of this.compiled) {
      if (!actionMatches(action, rule.action) || !subjectMatches(type, rule.subject)) continue;
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
