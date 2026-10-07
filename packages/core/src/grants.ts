import { type PolicySet } from './builder.js';
import { CastellanError } from './errors.js';
import { ANY, type Rule } from './rule.js';
import { type ScopeTree } from './scope.js';

/** One role assignment read from the app's tables: principal → role, at a scope. */
export interface Assignment {
  /** A role defined in code (`role('site.read')`) or a custom role listed in `GrantSnapshot.roles`. */
  role: string;
  /** Scope key the assignment covers, e.g. `'org:812'`, `'group:north'`, `'site:1001'`, `'*'`. */
  scope: string;
  /** Inactive before this instant. Dates, ISO strings and epoch milliseconds are accepted. */
  validFrom?: Date | string | number | null;
  /** Inactive from this instant on. */
  validUntil?: Date | string | number | null;
  /** Limits the assignment to a subset of the role (delegation): role keys it may use. */
  limitTo?: readonly string[] | null;
  /** Free-form origin label surfaced by `explain()`: `'direct'`, `'delegation'`, `'sso'`, … */
  source?: string;
}

/** Everything castellan needs to decide for one principal in one domain. Built by the app. */
export interface GrantSnapshot {
  /** Assignments that may reach the domain. Membership status, delegation and partner reach are resolved by the app. */
  assignments: readonly Assignment[];
  /** Custom roles used by the assignments: role → the code roles (keys) it inherits. */
  roles?: Readonly<Record<string, readonly string[]>>;
  /** The resource hierarchy for this domain. */
  tree: ScopeTree;
}

/** Reads grants from the app's own tables. castellan never writes them. */
export interface GrantSource<U = unknown> {
  /** Grants that reach `domain` for this user. */
  load(user: U, domain: string): Promise<GrantSnapshot> | GrantSnapshot;
}

/** How an assignment reaches the request domain. */
export interface ReachEntry {
  /** The assignment scope. */
  scope: string;
  /** True when the assignment scope contains the domain (platform, partner, the tenant itself). */
  covers: boolean;
}

/** Something in a snapshot castellan skipped (never thrown at request time). */
export type GrantIssue =
  | { kind: 'unknown-role'; role: string; source?: string }
  | { kind: 'unknown-key'; key: string; role: string }
  | { kind: 'role-shadowed'; role: string }
  | { kind: 'invalid-window'; role: string; scope: string };

/** Policies prepared once for external grants mode. */
export interface ExternalPolicies {
  rulesByPrincipal: ReadonlyMap<string, readonly Rule[]>;
  globalDenies: readonly Rule[];
  /** Code role inheritance: member → roles it inherits. */
  inherits: ReadonlyMap<string, readonly string[]>;
  known: ReadonlySet<string>;
}

/** Result of applying a snapshot to one domain. */
export interface GrantContext {
  principal: string;
  domain: string;
  /** Allow rules of the roles that reach the domain, plus global denies. */
  rules: Rule[];
  /** Role key → the scopes through which it reaches the domain. */
  reach: Map<string, ReachEntry[]>;
  /** Casbin `g` rows `[member, role, domain]`. */
  links: Array<[string, string, string]>;
  /** Earliest instant at which an assignment starts or stops; rebuild the ability after it. */
  expiresAt?: number;
  issues: GrantIssue[];
}

/**
 * Validates and indexes policies for external grants mode. Allowed rules: `role(...).can(...)`
 * (scoped by assignments) and `everyone.cannot(...)` (global guardrails). Rejected: `everyone.can`
 * (would be unscoped), role-level `cannot` (decision 009) and role domains other than `*`.
 */
export function prepareExternalPolicies(sets: readonly PolicySet[]): ExternalPolicies {
  const rulesByPrincipal = new Map<string, Rule[]>();
  const globalDenies: Rule[] = [];
  const inherits = new Map<string, string[]>();
  const known = new Set<string>();
  for (const set of sets) {
    for (const rule of set.rules) {
      if (rule.domain !== ANY) {
        throw new CastellanError(`External grants mode: role "${rule.principal}" has domain "${rule.domain}"; scopes come from assignments`);
      }
      if (rule.principal === ANY) {
        if (rule.effect === 'allow') {
          throw new CastellanError(
            `External grants mode: everyone.can('${rule.action}', '${rule.subject}') would be unscoped. ` +
              'Grant it through a role and an assignment.',
          );
        }
        globalDenies.push(rule);
        continue;
      }
      if (rule.effect === 'deny') {
        throw new CastellanError(
          `External grants mode: role("${rule.principal}").cannot(...) is not supported; use everyone.cannot(...) for guardrails`,
        );
      }
      known.add(rule.principal);
      rulesByPrincipal.set(rule.principal, [...(rulesByPrincipal.get(rule.principal) ?? []), rule]);
    }
    for (const link of set.roleLinks) {
      if (link.domain !== ANY) throw new CastellanError(`External grants mode: role link "${link.member}" → "${link.role}" must use domain "*"`);
      known.add(link.member);
      known.add(link.role);
      inherits.set(link.member, [...(inherits.get(link.member) ?? []), link.role]);
    }
  }
  return { rulesByPrincipal, globalDenies, inherits, known };
}

function toTime(value: Date | string | number | null | undefined): number | undefined | null {
  if (value === undefined || value === null) return undefined;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

/**
 * Applies a snapshot to one principal and domain: drops assignments outside their validity window
 * or outside the domain, expands roles, intersects `limitTo`, and records how each role reaches the domain.
 */
export function buildGrantContext(
  policies: ExternalPolicies,
  snapshot: GrantSnapshot,
  principal: string,
  domain: string,
  now: number,
): GrantContext {
  if (!snapshot || !Array.isArray(snapshot.assignments) || !snapshot.tree) {
    throw new CastellanError('Invalid grant snapshot: expected { assignments, tree }');
  }
  const { tree } = snapshot;
  const custom = snapshot.roles ?? {};
  const issues: GrantIssue[] = [];
  const reach = new Map<string, ReachEntry[]>();
  const links: Array<[string, string, string]> = [];
  let expiresAt: number | undefined;
  const earliest = (t: number) => {
    expiresAt = expiresAt === undefined ? t : Math.min(expiresAt, t);
  };

  for (const role of Object.keys(custom)) {
    if (policies.known.has(role)) issues.push({ kind: 'role-shadowed', role });
  }
  const isCustom = (name: string) => Object.hasOwn(custom, name) && !policies.known.has(name);

  // Expands a key into itself plus everything it inherits (code links and custom roles).
  const closure = (name: string, owner: string): Set<string> => {
    const out = new Set<string>();
    const stack = [name];
    while (stack.length) {
      const current = stack.pop()!;
      if (out.has(current)) continue;
      if (isCustom(current)) {
        for (const key of custom[current] ?? []) {
          if (policies.known.has(key) || isCustom(key)) stack.push(key);
          else issues.push({ kind: 'unknown-key', key, role: current });
        }
        continue; // custom roles carry no rules of their own
      }
      if (!policies.known.has(current)) {
        issues.push({ kind: 'unknown-key', key: current, role: owner });
        continue;
      }
      out.add(current);
      for (const parent of policies.inherits.get(current) ?? []) stack.push(parent);
    }
    return out;
  };

  // Code inheritance and custom roles become ordinary Casbin role links in domain `*`.
  for (const [member, roles] of policies.inherits) for (const role of roles) links.push([member, role, ANY]);
  for (const [role, keys] of Object.entries(custom)) {
    if (!isCustom(role)) continue;
    for (const key of keys) if (policies.known.has(key) || isCustom(key)) links.push([role, key, ANY]);
  }

  snapshot.assignments.forEach((assignment, index) => {
    const { role, scope } = assignment;
    const from = toTime(assignment.validFrom);
    const until = toTime(assignment.validUntil);
    if (from === null || until === null || !role || !scope) {
      issues.push({ kind: 'invalid-window', role, scope });
      return;
    }
    if (from !== undefined && from > now) {
      earliest(from);
      return;
    }
    if (until !== undefined && until <= now) return;
    if (until !== undefined) earliest(until);

    const covers = tree.contains(scope, domain);
    if (!covers && !tree.contains(domain, scope)) return;
    if (!policies.known.has(role) && !isCustom(role)) {
      issues.push({ kind: 'unknown-role', role, source: assignment.source });
      return;
    }

    let keys = closure(role, role);
    if (assignment.limitTo) {
      const allowed = new Set<string>();
      for (const limit of assignment.limitTo) for (const key of closure(limit, role)) allowed.add(key);
      keys = new Set([...keys].filter((k) => allowed.has(k)));
      const delegated = `${role}#limit:${index}`;
      links.push([principal, delegated, scope]);
      for (const key of keys) links.push([delegated, key, ANY]);
    } else {
      links.push([principal, role, scope]);
    }
    for (const key of keys) {
      const entries = reach.get(key) ?? [];
      if (!entries.some((e) => e.scope === scope)) entries.push({ scope, covers });
      reach.set(key, entries);
    }
  });

  const rules: Rule[] = [...policies.globalDenies];
  for (const key of reach.keys()) rules.push(...(policies.rulesByPrincipal.get(key) ?? []));
  return { principal, domain, rules, reach, links, expiresAt, issues };
}
