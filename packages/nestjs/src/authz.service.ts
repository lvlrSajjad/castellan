import {
  type Ability,
  type Authz,
  type CheckOptions,
  type Explanation,
  ForbiddenError,
  type PolicySet,
  type ResolvedScope,
  type Rule,
  type SubjectType,
  type SyncMode,
  type SyncReport,
  resolveScope,
} from '@castellanjs/core';
import { Inject, Injectable } from '@nestjs/common';
import { AUTHZ_INSTANCE, AUTHZ_MODULE_OPTIONS, REQUEST_ABILITY } from './constants.js';
import { AuthzForbiddenException } from './exceptions.js';
import type { AuthzModuleOptions } from './options.js';

/**
 * Injectable facade over castellan's core `Authz`, for checks in services
 * (where decorators do not reach) and for runtime policy management.
 */
@Injectable()
export class AuthzService<U = any, A extends string = string> {
  constructor(
    @Inject(AUTHZ_INSTANCE) readonly authz: Authz<U, A>,
    @Inject(AUTHZ_MODULE_OPTIONS) private readonly options: AuthzModuleOptions<U>,
  ) {}

  /** Builds the in-memory ability for a user. */
  abilityFor(user: U, options: Pick<CheckOptions, 'domain' | 'snapshot'> = {}): Promise<Ability<A>> {
    return this.authz.abilityFor(user, options);
  }

  /**
   * Returns the ability for a request: the one the guard attached, or a new one built from
   * `userFromRequest` / `domainFromRequest`.
   */
  async abilityForRequest(request: any): Promise<Ability<A>> {
    if (request?.[REQUEST_ABILITY]) return request[REQUEST_ABILITY] as Ability<A>;
    const user = this.userFromRequest(request);
    const snapshot = await this.options.snapshotFromRequest?.(request, user);
    const ability = await this.abilityFor(user, { domain: this.domainFromRequest(request, user), snapshot });
    if (request) request[REQUEST_ABILITY] = ability;
    return ability;
  }

  /**
   * The validated row filter for `action` on a subject type in this request: `{ kind: 'none' }` or a
   * condition for `applyScope` (`@castellanjs/typeorm`).
   */
  async scopeFor(request: any, action: A | 'manage', subject: SubjectType): Promise<ResolvedScope> {
    return resolveScope(await this.abilityForRequest(request), action, subject);
  }

  /** Checks through the Casbin enforcer (source of truth). */
  enforce(user: U, action: A | 'manage', subject: SubjectType | object, options?: CheckOptions): Promise<boolean> {
    return this.authz.enforce(user, action, subject, options);
  }

  /** Throws {@link AuthzForbiddenException} (HTTP 403) with the rule's reason unless allowed. */
  async assert(user: U, action: A | 'manage', subject: SubjectType | object, options?: CheckOptions): Promise<void> {
    try {
      await this.authz.assert(user, action, subject, options);
    } catch (error) {
      if (error instanceof ForbiddenError) throw new AuthzForbiddenException(error.details);
      throw error;
    }
  }

  /** Explains a decision in both layers. */
  explain(user: U, action: A | 'manage', subject: SubjectType | object, options?: CheckOptions): Promise<Explanation & { enforcer: boolean; agree: boolean }> {
    return this.authz.explain(user, action, subject, options);
  }

  /** Adds runtime-managed rules. */
  grant(policies: PolicySet): Promise<Rule[]> {
    return this.authz.grant(policies);
  }

  /** Removes runtime-managed rules. */
  revoke(policies: PolicySet): Promise<Rule[]> {
    return this.authz.revoke(policies);
  }

  /** Assigns a role to a user (or role) in a domain (`*` = every domain). */
  assignRole(principal: string, role: string, domain?: string): Promise<boolean> {
    return this.authz.assignRole(principal, role, domain);
  }

  /** Removes a role assignment. */
  unassignRole(principal: string, role: string, domain?: string): Promise<boolean> {
    return this.authz.unassignRole(principal, role, domain);
  }

  /** Re-syncs code-defined policies. */
  syncPolicies(policies: PolicySet | readonly PolicySet[], mode?: SyncMode): Promise<SyncReport> {
    return this.authz.syncPolicies(policies, mode);
  }

  /** @internal */
  userFromRequest(request: any): U {
    return (this.options.userFromRequest ? this.options.userFromRequest(request) : request?.user) as U;
  }

  /** @internal */
  domainFromRequest(request: any, user: U): string | undefined {
    return this.options.domainFromRequest?.(request, user);
  }

  /** @internal */
  get moduleOptions(): AuthzModuleOptions<U> {
    return this.options;
  }
}
