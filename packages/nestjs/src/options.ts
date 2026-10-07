import type { AuthzOptions, GrantSnapshot } from '@castellanjs/core';
import type { ModuleMetadata } from '@nestjs/common';

/** Options for {@link AuthzModule}. Everything from core's `AuthzOptions`, plus request mapping. */
export interface AuthzModuleOptions<U = any> extends AuthzOptions<U> {
  /** Extracts the authenticated user from the request. Default: `req.user`. */
  userFromRequest?: (request: any) => U | undefined | null;
  /** Extracts the domain (tenant) from the request. Required when `domains` is enabled (the default). */
  domainFromRequest?: (request: any, user: U) => string | undefined;
  /**
   * External grants mode: returns the grant snapshot for this request, e.g. built from an access
   * context an earlier guard attached. Takes precedence over a configured `GrantSource`.
   */
  snapshotFromRequest?: (request: any, user: U) => GrantSnapshot | undefined | Promise<GrantSnapshot | undefined>;
  /**
   * External grants mode: what to answer when no assignment reaches the request domain at all.
   * `'not-found'` hides whether the domain exists. Default `'forbidden'`.
   */
  onNoDomainAccess?: 'forbidden' | 'not-found';
  /**
   * What to answer when a `@CheckAbility` instance loaded with `load` is denied. `'not-found'`
   * hides whether the row exists. Default `'forbidden'`.
   */
  onDeniedInstance?: 'forbidden' | 'not-found';
}

export interface AuthzModuleAsyncOptions<U = any> extends Pick<ModuleMetadata, 'imports'> {
  useFactory: (...args: any[]) => AuthzModuleOptions<U> | Promise<AuthzModuleOptions<U>>;
  inject?: any[];
}
