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
import { CHECK_ABILITY_METADATA, REQUEST_ABILITY } from './constants.js';
import type { AbilityRequirement } from './decorators.js';
import { AuthzForbiddenException } from './exceptions.js';
import { getRequest, loadGraphql } from './request.js';
import { AuthzService } from './authz.service.js';

/**
 * Enforces `@CheckAbility` requirements and attaches the user's ability to the request
 * (read it with `@CurrentAbility()`). Checks run in memory; they are proven equivalent to the
 * Casbin enforcer by castellan's parity suite.
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
    const request = getRequest(context);
    const user = this.authz.userFromRequest(request);
    if (user === undefined || user === null) {
      if (requirements.length) throw new UnauthorizedException();
      return true;
    }
    const ability: Ability = await this.authz.abilityForRequest(request);
    for (const { action, subject, options } of requirements) {
      let target: unknown = subject;
      if (options.load) {
        target = await options.load(request, this.moduleRef);
        if (target === null || target === undefined) throw new NotFoundException();
      }
      const explanation = ability.explain(action, target as object, options.field);
      if (!explanation.allowed) {
        throw new AuthzForbiddenException({
          action,
          subjectType: subjectTypeName(subject),
          field: options.field,
          reason: explanation.decidingRule?.reason,
        });
      }
    }
    request[REQUEST_ABILITY] = ability;
    return true;
  }
}

