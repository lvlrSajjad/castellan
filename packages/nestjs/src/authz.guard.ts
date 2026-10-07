import { type Ability, subjectTypeName } from '@castellanjs/core';
import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { CHECK_ABILITY_METADATA, REQUEST_ABILITY, REQUIRE_PERMISSION_METADATA } from './constants.js';
import type { AbilityRequirement } from './decorators.js';
import { AuthzForbiddenException, PermissionRequiredException } from './exceptions.js';
import { getRequest, loadGraphql } from './request.js';
import { AuthzService } from './authz.service.js';

/**
 * Enforces `@RequirePermission` and `@CheckAbility` requirements and attaches the user's ability to
 * the request (read it with `@CurrentAbility()`). Checks run in memory; they are proven equivalent
 * to the Casbin enforcer by castellan's parity suites.
 *
 * Order: 401 without a user; then, in external grants mode, 404 when nothing reaches the domain
 * (`onNoDomainAccess: 'not-found'`); then `@RequirePermission` (403); then `@CheckAbility`
 * (404 when `load` finds nothing, 403 or 404 when the instance is denied).
 */
@Injectable()
export class AuthzGuard implements CanActivate {
  constructor(
    @Inject(AuthzService) private readonly authz: AuthzService,
    @Inject(ModuleRef) private readonly moduleRef: ModuleRef,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType<string>() === 'graphql') await loadGraphql();
    const requirements = [
      ...((Reflect.getMetadata(CHECK_ABILITY_METADATA, context.getClass()) as AbilityRequirement[] | undefined) ?? []),
      ...((Reflect.getMetadata(CHECK_ABILITY_METADATA, context.getHandler()) as AbilityRequirement[] | undefined) ?? []),
    ];
    const permissions = [
      ...((Reflect.getMetadata(REQUIRE_PERMISSION_METADATA, context.getClass()) as string[][] | undefined) ?? []),
      ...((Reflect.getMetadata(REQUIRE_PERMISSION_METADATA, context.getHandler()) as string[][] | undefined) ?? []),
    ];
    const request = getRequest(context);
    const user = this.authz.userFromRequest(request);
    if (user === undefined || user === null) {
      if (requirements.length || permissions.length) throw new UnauthorizedException();
      return true;
    }
    const ability: Ability = await this.authz.abilityForRequest(request);
    const options = this.authz.moduleOptions;
    if (
      (requirements.length || permissions.length) &&
      options.onNoDomainAccess === 'not-found' &&
      ability.scope?.reach &&
      ability.permissions().length === 0
    ) {
      throw new NotFoundException();
    }
    for (const keys of permissions) {
      if (!ability.holds(keys)) throw new PermissionRequiredException(keys);
    }
    for (const { action, subject, options: check } of requirements) {
      let target: unknown = subject;
      if (check.load) {
        target = await check.load(request, this.moduleRef);
        if (target === null || target === undefined) throw new NotFoundException();
      }
      const explanation = ability.explain(action, target as object, check.field);
      if (!explanation.allowed) {
        if (check.load && options.onDeniedInstance === 'not-found') throw new NotFoundException();
        throw new AuthzForbiddenException({
          action,
          subjectType: subjectTypeName(subject),
          field: check.field,
          reason: explanation.decidingRule?.reason,
        });
      }
    }
    request[REQUEST_ABILITY] = ability;
    return true;
  }
}

