import { Authz } from '@castellan/core';
import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { AuthzGuard } from './authz.guard.js';
import { AuthzService } from './authz.service.js';
import { AUTHZ_INSTANCE, AUTHZ_MODULE_OPTIONS } from './constants.js';
import type { AuthzModuleAsyncOptions, AuthzModuleOptions } from './options.js';

const authzProvider: Provider = {
  provide: AUTHZ_INSTANCE,
  useFactory: (options: AuthzModuleOptions) => Authz.create(options),
  inject: [AUTHZ_MODULE_OPTIONS],
};

const exported = [AuthzService, AuthzGuard, AUTHZ_INSTANCE];

/**
 * Global module that creates the Casbin enforcer, syncs code-defined policies at startup
 * and provides {@link AuthzService} and {@link AuthzGuard}.
 *
 * @example
 * ```ts
 * AuthzModule.forRootAsync({
 *   inject: [DataSource],
 *   useFactory: (ds: DataSource) => ({
 *     adapter: createTypeormAdapter(ds),
 *     policies,
 *     domainFromRequest: (req) => req.user.orgId,
 *   }),
 * })
 * ```
 */
@Module({})
export class AuthzModule {
  static forRoot<U>(options: AuthzModuleOptions<U>): DynamicModule {
    return {
      module: AuthzModule,
      global: true,
      providers: [{ provide: AUTHZ_MODULE_OPTIONS, useValue: options }, authzProvider, AuthzService, AuthzGuard],
      exports: exported,
    };
  }

  static forRootAsync<U>(options: AuthzModuleAsyncOptions<U>): DynamicModule {
    return {
      module: AuthzModule,
      global: true,
      imports: options.imports ?? [],
      providers: [
        { provide: AUTHZ_MODULE_OPTIONS, useFactory: options.useFactory, inject: options.inject ?? [] },
        authzProvider,
        AuthzService,
        AuthzGuard,
      ],
      exports: exported,
    };
  }
}
