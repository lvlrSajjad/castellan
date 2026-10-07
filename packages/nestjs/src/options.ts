import type { AuthzOptions } from '@castellanjs/core';
import type { ModuleMetadata } from '@nestjs/common';

/** Options for {@link AuthzModule}. Everything from core's `AuthzOptions`, plus request mapping. */
export interface AuthzModuleOptions<U = any> extends AuthzOptions<U> {
  /** Extracts the authenticated user from the request. Default: `req.user`. */
  userFromRequest?: (request: any) => U | undefined | null;
  /** Extracts the domain (tenant) from the request. Required when `domains` is enabled (the default). */
  domainFromRequest?: (request: any, user: U) => string | undefined;
}

export interface AuthzModuleAsyncOptions<U = any> extends Pick<ModuleMetadata, 'imports'> {
  useFactory: (...args: any[]) => AuthzModuleOptions<U> | Promise<AuthzModuleOptions<U>>;
  inject?: any[];
}
