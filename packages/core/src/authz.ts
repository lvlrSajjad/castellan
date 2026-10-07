import { type Adapter, type Enforcer, type Watcher, newEnforcer } from 'casbin';
import { Ability, type Explanation } from './ability.js';
import { type PolicySet, type RoleLink } from './builder.js';
import { CastellanError, ForbiddenError } from './errors.js';
import { buildModel, registerMatchers } from './model.js';
import { ANY, type PolicyRow, type RequestObject, type Rule, rowToRule, ruleToRow } from './rule.js';
import { type DetectSubjectType, type SubjectType, resolveSubject } from './subject.js';

/** How code-defined policies are reconciled with the policy store at startup. */
export type SyncMode = 'replace' | 'merge' | 'dry-run' | 'off';

export interface AuthzOptions<U> {
  /** Casbin adapter for policy storage (e.g. from `@castellan/typeorm`). Omit for in-memory. */
  adapter?: Adapter;
  /** Multi-tenant mode: every check needs a domain. Default `true`. */
  domains?: boolean;
  /** Code-defined policies, synced into the store according to `sync`. */
  policies?: PolicySet | readonly PolicySet[];
  /**
   * - `replace` (default): add missing code rules, remove code rules no longer defined. Runtime grants are untouched.
   * - `merge`: only add missing code rules.
   * - `dry-run`: compute and log the diff, write nothing.
   * - `off`: do not sync.
   */
  sync?: SyncMode;
  /** Maps a user to its Casbin principal id. Default: `String(user.id)`. */
  principalId?: (user: U) => string;
  /** Custom subject type detection for instances. */
  detectSubjectType?: DetectSubjectType;
  /** Optional Casbin watcher for multi-instance policy invalidation. */
  watcher?: Watcher;
  /** Receives lint warnings and sync reports. Default: `console`. Pass `false` to silence. */
  logger?: Pick<Console, 'warn' | 'log'> | false;
}

export interface CheckOptions {
  /** Domain (tenant). Required when `domains` is enabled. */
  domain?: string;
  /** Field, for field-level permissions. */
  field?: string;
}

export interface SyncReport {
  mode: SyncMode;
  added: Rule[];
  removed: Rule[];
  unchanged: number;
  addedRoleLinks: RoleLink[];
  warnings: string[];
}

const defaultPrincipalId = (user: unknown): string => {
  const id = (user as { id?: unknown } | null | undefined)?.id;
  if (id === undefined || id === null || id === '') {
    throw new CastellanError('Cannot derive a principal id: user.id is missing. Configure principalId.');
  }
  return String(id);
};

const rowKey = (row: PolicyRow) => JSON.stringify(row);

/**
 * castellan runtime: owns the Casbin enforcer and exposes typed checks and policy management.
 *
 * @example
 * ```ts
 * const authz = await Authz.create({ adapter, policies });
 * const ability = await authz.abilityFor(user, { domain: user.orgId });
 * ability.can('update', workOrder);
 * await authz.assert(user, 'delete', workOrder, { domain: user.orgId }); // throws ForbiddenError
 * ```
 */
export class Authz<U = unknown, A extends string = string> {
  private constructor(
    /** The underlying Casbin enforcer (source of truth). */
    readonly enforcer: Enforcer,
    private readonly options: AuthzOptions<U> & { domains: boolean },
  ) {}

  /** Creates the enforcer, registers matchers, loads policies and syncs code-defined policies. */
  static async create<U = unknown, A extends string = string>(options: AuthzOptions<U> = {}): Promise<Authz<U, A>> {
    const domains = options.domains ?? true;
    const enforcer = await newEnforcer(buildModel({ domains }));
    await registerMatchers(enforcer, { domains });
    if (options.adapter) {
      enforcer.setAdapter(options.adapter);
      await enforcer.loadPolicy();
    }
    if (options.watcher) enforcer.setWatcher(options.watcher);
    const authz = new Authz<U, A>(enforcer, { ...options, domains });
    const sets = authz.policySets(options.policies);
    if (sets.length && (options.sync ?? 'replace') !== 'off') {
      const report = await authz.syncPolicies(sets, options.sync ?? 'replace');
      authz.log('log', formatSyncReport(report));
    }
    return authz;
  }

  /** Whether this instance uses the multi-tenant model. */
  get domains(): boolean {
    return this.options.domains;
  }

  /** The principal id Casbin uses for a user. */
  principalOf(user: U): string {
    return (this.options.principalId ?? defaultPrincipalId)(user);
  }

  /**
   * Builds the in-memory ability for a user: their own rules, rules of every role they hold
   * (transitively, in the domain), and `everyone` rules.
   */
  async abilityFor(user: U, options: Pick<CheckOptions, 'domain'> = {}): Promise<Ability<A>> {
    const domain = this.requireDomain(options.domain);
    const principal = this.principalOf(user);
    const roles = domain === undefined
      ? await this.enforcer.getImplicitRolesForUser(principal)
      : await this.enforcer.getImplicitRolesForUser(principal, domain);
    const principals = new Set([principal, ...roles, ANY]);
    const rules = (await this.enforcer.getPolicy())
      .map((row) => rowToRule(row, this.domains))
      .filter((r) => principals.has(r.principal) && (domain === undefined || r.domain === ANY || r.domain === domain));
    return new Ability<A>(rules, { user, domain, detectSubjectType: this.options.detectSubjectType });
  }

  /** Checks through the Casbin enforcer (the source of truth). */
  async enforce(user: U, action: A | 'manage', subject: SubjectType | object, options: CheckOptions = {}): Promise<boolean> {
    const domain = this.requireDomain(options.domain);
    const { type, data } = resolveSubject(subject, this.options.detectSubjectType);
    const obj: RequestObject = { type, data, field: options.field, user };
    const principal = this.principalOf(user);
    return domain === undefined
      ? this.enforcer.enforce(principal, obj, action)
      : this.enforcer.enforce(principal, domain, obj, action);
  }

  /**
   * Throws {@link ForbiddenError} unless the enforcer allows the action. The error carries the
   * deny rule's reason, looked up from the in-memory ability.
   */
  async assert(user: U, action: A | 'manage', subject: SubjectType | object, options: CheckOptions = {}): Promise<void> {
    if (await this.enforce(user, action, subject, options)) return;
    const explanation = (await this.abilityFor(user, options)).explain(action, subject, options.field);
    const { type } = resolveSubject(subject, this.options.detectSubjectType);
    throw new ForbiddenError(explanation.decidingRule?.reason ?? explanation.message, {
      action,
      subjectType: type,
      field: options.field,
      reason: explanation.decidingRule?.reason,
    });
  }

  /** Explains a decision in both layers; `agree` is false only if they disagree (a bug). */
  async explain(
    user: U,
    action: A | 'manage',
    subject: SubjectType | object,
    options: CheckOptions = {},
  ): Promise<Explanation & { enforcer: boolean; agree: boolean }> {
    const ability = await this.abilityFor(user, options);
    const explanation = ability.explain(action, subject, options.field);
    const enforcer = await this.enforce(user, action, subject, options);
    return { ...explanation, enforcer, agree: enforcer === explanation.allowed };
  }

  /** Adds runtime-managed rules (e.g. from an admin UI). Uses the same typed DSL. */
  async grant(policies: PolicySet): Promise<Rule[]> {
    const rows = this.uniqueRows(policies.rules.map((r) => ({ ...r, origin: 'runtime' as const })));
    const existing = new Set((await this.enforcer.getPolicy()).map(rowKey));
    const toAdd = rows.filter((row) => !existing.has(rowKey(row)));
    if (toAdd.length) await this.enforcer.addPolicies(toAdd);
    await this.addRoleLinks(policies.roleLinks);
    return toAdd.map((row) => rowToRule(row, this.domains));
  }

  /** Removes runtime-managed rules previously added with {@link grant}. */
  async revoke(policies: PolicySet): Promise<Rule[]> {
    const rows = this.uniqueRows(policies.rules.map((r) => ({ ...r, origin: 'runtime' as const })));
    const existing = new Set((await this.enforcer.getPolicy()).map(rowKey));
    const toRemove = rows.filter((row) => existing.has(rowKey(row)));
    if (toRemove.length) await this.enforcer.removePolicies(toRemove);
    for (const link of policies.roleLinks) await this.unassignRole(link.member, link.role, link.domain);
    return toRemove.map((row) => rowToRule(row, this.domains));
  }

  /** Assigns a role to a user (or makes a role inherit another). Domain `*` applies everywhere. */
  async assignRole(principal: string, role: string, domain: string = ANY): Promise<boolean> {
    return this.domains
      ? this.enforcer.addGroupingPolicy(principal, role, domain)
      : this.enforcer.addGroupingPolicy(principal, role);
  }

  /** Removes a role assignment. */
  async unassignRole(principal: string, role: string, domain: string = ANY): Promise<boolean> {
    return this.domains
      ? this.enforcer.removeGroupingPolicy(principal, role, domain)
      : this.enforcer.removeGroupingPolicy(principal, role);
  }

  /** Roles a principal holds in a domain, including inherited ones. */
  async rolesFor(principal: string, domain?: string): Promise<string[]> {
    const dom = this.requireDomain(domain);
    return dom === undefined
      ? this.enforcer.getImplicitRolesForUser(principal)
      : this.enforcer.getImplicitRolesForUser(principal, dom);
  }

  /** Every stored rule, decoded. */
  async listRules(): Promise<Rule[]> {
    return (await this.enforcer.getPolicy()).map((row) => rowToRule(row, this.domains));
  }

  /**
   * Reconciles code-defined policies with the store. Only rows tagged `__origin: "code"` are
   * ever removed, so runtime grants survive. Role links are add-only.
   */
  async syncPolicies(policies: PolicySet | readonly PolicySet[], mode: SyncMode = 'replace'): Promise<SyncReport> {
    const sets = this.policySets(policies);
    const warnings = sets.flatMap((s) => s.warnings);
    for (const warning of warnings) this.log('warn', `[castellan] ${warning}`);
    const report: SyncReport = { mode, added: [], removed: [], unchanged: 0, addedRoleLinks: [], warnings };
    if (mode === 'off') return report;

    const desired = this.uniqueRows(sets.flatMap((s) => s.rules).map((r) => ({ ...r, origin: 'code' as const })));
    const desiredKeys = new Set(desired.map(rowKey));
    const existing = await this.enforcer.getPolicy();
    const existingKeys = new Set(existing.map(rowKey));
    const toAdd = desired.filter((row) => !existingKeys.has(rowKey(row)));
    const toRemove =
      mode === 'merge'
        ? []
        : existing.filter((row) => rowToRule(row, this.domains).origin === 'code' && !desiredKeys.has(rowKey(row)));
    report.added = toAdd.map((row) => rowToRule(row, this.domains));
    report.removed = toRemove.map((row) => rowToRule(row, this.domains));
    report.unchanged = desired.length - toAdd.length;

    const links = sets.flatMap((s) => s.roleLinks);
    const existingLinks = new Set((await this.enforcer.getGroupingPolicy()).map(rowKey));
    report.addedRoleLinks = links.filter((l) => !existingLinks.has(rowKey(this.linkRow(l))));

    if (mode === 'dry-run') return report;
    if (toRemove.length) await this.enforcer.removePolicies(toRemove);
    if (toAdd.length) await this.enforcer.addPolicies(toAdd);
    await this.addRoleLinks(report.addedRoleLinks);
    return report;
  }

  /**
   * Exports the policy store as Casbin CSV (`p, …` / `g, …` lines), e.g. for the Casbin online editor.
   * Note: conditions use castellan's `condMatch`, which other Casbin implementations do not provide.
   */
  async exportPolicies({ format = 'csv' }: { format?: 'csv' } = {}): Promise<string> {
    if (format !== 'csv') throw new CastellanError(`Unsupported export format "${format}"`);
    const quote = (v: string) => (/[",\s]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const lines = [
      ...(await this.enforcer.getPolicy()).map((row) => ['p', ...row].map(quote).join(', ')),
      ...(await this.enforcer.getGroupingPolicy()).map((row) => ['g', ...row].map(quote).join(', ')),
    ];
    return lines.join('\n');
  }

  /** Reloads policies from the adapter (e.g. after a watcher notification). */
  async reload(): Promise<void> {
    await this.enforcer.loadPolicy();
  }

  private requireDomain(domain: string | undefined): string | undefined {
    if (!this.domains) return undefined;
    if (domain === undefined || domain === '') {
      throw new CastellanError('A domain is required when domains are enabled (pass { domain }).');
    }
    return domain;
  }

  private uniqueRows(rules: Rule[]): PolicyRow[] {
    const seen = new Map<string, PolicyRow>();
    for (const rule of rules) {
      const row = ruleToRow(rule, this.domains);
      seen.set(rowKey(row), row);
    }
    return [...seen.values()];
  }

  private linkRow(link: RoleLink): string[] {
    return this.domains ? [link.member, link.role, link.domain] : [link.member, link.role];
  }

  private async addRoleLinks(links: readonly RoleLink[]): Promise<void> {
    for (const link of links) await this.assignRole(link.member, link.role, link.domain);
  }

  private policySets(policies: PolicySet | readonly PolicySet[] | undefined): PolicySet[] {
    if (!policies) return [];
    return Array.isArray(policies) ? [...(policies as PolicySet[])] : [policies as PolicySet];
  }

  private log(level: 'warn' | 'log', message: string): void {
    if (this.options.logger === false) return;
    (this.options.logger ?? console)[level](message);
  }
}

/** One-line summary of a sync report. */
export function formatSyncReport(report: SyncReport): string {
  return (
    `[castellan] policy sync (${report.mode}): +${report.added.length} -${report.removed.length} ` +
    `=${report.unchanged}, +${report.addedRoleLinks.length} role links`
  );
}
