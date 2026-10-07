import { type Conditions, type Refs, createRefProxy, serializeConditions } from './conditions.js';
import { ConditionError } from './errors.js';
import { lintRules } from './lint.js';
import { ALL, ANY, type Effect, MANAGE, type Rule } from './rule.js';
import { type AnyClass, subjectTypeName } from './subject.js';

/** A role-inheritance (or user-to-role) link: Casbin `g` row `[member, role, domain]`. */
export interface RoleLink {
  member: string;
  role: string;
  domain: string;
}

/** The output of {@link definePolicies}: compiled rules and role links, ready to sync into Casbin. */
export interface PolicySet {
  readonly rules: readonly Rule[];
  readonly roleLinks: readonly RoleLink[];
  /** Lint warnings, e.g. an unconditional `cannot` shadowing a conditional `can`. */
  readonly warnings: readonly string[];
}

/** Returned by `can`/`cannot`: attach a reason, or chain more rules for the same principal. */
export interface RuleHandle<A extends string = string> {
  /** Attaches a reason to the rule(s) just defined, surfaced by `relevantRuleFor()`, `assert()` and `ForbiddenError`. */
  because(reason: string): RuleHandle<A>;
  /** Adds another allow rule for the same principal: `role('site.read').can('read', Site).can('read', WorkOrder)`. */
  readonly can: DefineRule<A>;
  /** Adds another deny rule for the same principal. */
  readonly cannot: DefineRule<A>;
}

type Actions<A extends string> = A | typeof MANAGE | ReadonlyArray<A | typeof MANAGE>;
type Fields<T> = ReadonlyArray<Extract<keyof T, string>>;

/** `can` / `cannot` signature, typed against the subject class. */
export interface DefineRule<A extends string> {
  <C extends AnyClass>(action: Actions<A>, subject: C, conditions?: Conditions<InstanceType<C>>, fields?: Fields<InstanceType<C>>): RuleHandle<A>;
  <C extends AnyClass>(action: Actions<A>, subject: C, fields: Fields<InstanceType<C>>, conditions?: Conditions<InstanceType<C>>): RuleHandle<A>;
  (action: Actions<A>, subject: string, conditions?: Conditions, fields?: readonly string[]): RuleHandle<A>;
  (action: Actions<A>, subject: string, fields: readonly string[], conditions?: Conditions): RuleHandle<A>;
}

/** Rule-writing API for one principal (a role, a user id, or everyone). */
export interface PrincipalBuilder<A extends string> {
  readonly can: DefineRule<A>;
  readonly cannot: DefineRule<A>;
  /** Makes this principal inherit every permission of the given roles (Casbin `g` link). */
  readonly inherits: (...roles: string[]) => void;
}

export interface RoleOptions {
  /** Domain (tenant) the rules apply to. Defaults to `*` (every domain). */
  domain?: string;
}

/** Context passed to the {@link definePolicies} callback. */
export interface PolicyContext<U, A extends string> {
  /** Rules for a role (or any principal id). Call with a callback to group rules. */
  role: {
    (name: string, options?: RoleOptions): PrincipalBuilder<A>;
    (name: string, define: (builder: PrincipalBuilder<A>) => void): void;
    (name: string, options: RoleOptions, define: (builder: PrincipalBuilder<A>) => void): void;
  };
  /** Rules that apply to every principal (stored with principal `*`). */
  everyone: PrincipalBuilder<A>;
  /** Typed proxy: `user.id` becomes `{ $ref: 'user.id' }`, resolved per request. */
  user: Refs<U>;
}

/**
 * Defines static, syncable policies with a CASL-style DSL.
 *
 * Rules close over a symbolic `user`: `user.id` compiles to `{ $ref: 'user.id' }` and is
 * resolved at check time, so the same rules can be stored in Casbin, evaluated in memory,
 * and turned into SQL.
 *
 * @example
 * ```ts
 * export const policies = definePolicies<AppUser, 'read' | 'update' | 'delete'>(({ role, everyone, user }) => {
 *   everyone.can('read', WorkOrder, { siteId: { $in: user.siteIds } });
 *   everyone.cannot('delete', WorkOrder, { status: 'invoiced' }).because('Invoiced work orders are immutable');
 *   role('technician').can('update', WorkOrder, { assigneeId: user.id, status: { $ne: 'closed' } });
 *   role('site-manager', ({ can, inherits }) => {
 *     inherits('technician');
 *     can('manage', Site, { id: { $in: user.siteIds } });
 *   });
 * });
 * ```
 */
export function definePolicies<U = Record<string, unknown>, A extends string = string>(
  define: (context: PolicyContext<U, A>) => void,
): PolicySet {
  const rules: Rule[] = [];
  const roleLinks: RoleLink[] = [];

  const principalBuilder = (principal: string, domain: string): PrincipalBuilder<A> => {
    const defineRule = (effect: Effect) =>
      ((action: Actions<A>, subjectType: AnyClass | string, third?: unknown, fourth?: unknown): RuleHandle<A> => {
        const [conditions, fields] = Array.isArray(third) ? [fourth, third] : [third, fourth];
        const created = buildRules(principal, domain, effect, action, subjectType, conditions, fields as string[] | undefined);
        rules.push(...created);
        const handle: RuleHandle<A> = {
          because(reason) {
            for (const rule of created) rule.reason = reason;
            return handle;
          },
          can: builder.can,
          cannot: builder.cannot,
        };
        return handle;
      }) as DefineRule<A>;
    const builder: PrincipalBuilder<A> = {
      can: defineRule('allow'),
      cannot: defineRule('deny'),
      inherits: (...roles) => {
        for (const role of roles) roleLinks.push({ member: principal, role, domain });
      },
    };
    return builder;
  };

  const role = ((name: string, second?: RoleOptions | ((b: PrincipalBuilder<A>) => void), third?: (b: PrincipalBuilder<A>) => void) => {
    if (!name || name === ANY) throw new ConditionError('Role name must be a non-empty string other than "*"; use everyone');
    const options = typeof second === 'object' ? second : {};
    const callback = typeof second === 'function' ? second : third;
    const builder = principalBuilder(name, options.domain ?? ANY);
    if (callback) {
      callback(builder);
      return undefined;
    }
    return builder;
  }) as PolicyContext<U, A>['role'];

  define({ role, everyone: principalBuilder(ANY, ANY), user: createRefProxy<U>() });

  return { rules, roleLinks, warnings: lintRules(rules) };
}

/** Builds rules without the DSL, e.g. for an admin UI. Same validation as `definePolicies`. */
export function buildRules(
  principal: string,
  domain: string,
  effect: Effect,
  action: string | ReadonlyArray<string>,
  subjectType: AnyClass | string,
  conditions?: unknown,
  fields?: readonly string[],
): Rule[] {
  const actions = typeof action === 'string' ? [action] : [...action];
  if (actions.length === 0) throw new ConditionError('At least one action is required');
  const subject = subjectTypeName(subjectType);
  const serialized =
    conditions === undefined || conditions === null ? undefined : serializeConditions(conditions);
  if (fields !== undefined && (!Array.isArray(fields) || fields.some((f) => typeof f !== 'string' || !f))) {
    throw new ConditionError('fields must be an array of non-empty strings');
  }
  return actions.map((a) => {
    if (!a) throw new ConditionError('Action must be a non-empty string');
    const rule: Rule = { principal, domain, action: a, subject, effect };
    if (serialized && Object.keys(serialized).length) rule.conditions = serialized;
    if (fields?.length) rule.fields = [...fields];
    return rule;
  });
}

/** Merges several policy sets (e.g. one per feature module) into one. */
export function mergePolicySets(...sets: PolicySet[]): PolicySet {
  const rules = sets.flatMap((s) => s.rules);
  return { rules, roleLinks: sets.flatMap((s) => s.roleLinks), warnings: lintRules(rules) };
}

export { ALL, MANAGE };
