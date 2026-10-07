import type { SubjectType } from '@castellanjs/core';
import { type ExecutionContext, createParamDecorator } from '@nestjs/common';
import type { ModuleRef } from '@nestjs/core';
import { CHECK_ABILITY_METADATA, REQUEST_ABILITY, REQUIRE_PERMISSION_METADATA } from './constants.js';
import { getRequest } from './request.js';

export interface CheckAbilityOptions {
  /**
   * Loads the instance to check (e.g. by route param) so conditions apply.
   * Returning `null`/`undefined` responds 404. Without `load`, the check is type-level.
   */
  load?: (request: any, moduleRef: ModuleRef) => unknown | Promise<unknown>;
  /** Field to check, for field-level permissions. */
  field?: string;
}

export interface AbilityRequirement {
  action: string;
  subject: SubjectType;
  options: CheckAbilityOptions;
}

/**
 * Declares a permission the {@link AuthzGuard} enforces before the handler runs.
 * Stack several to require all of them. Works on controllers (applies to every handler) and methods.
 *
 * @example
 * ```ts
 * @UseGuards(AuthzGuard)
 * @CheckAbility('update', WorkOrder, { load: (req, refs) => refs.get(WorkOrderService).find(req.params.id) })
 * @Patch(':id')
 * update() {}
 * ```
 */
export function CheckAbility(action: string, subject: SubjectType, options: CheckAbilityOptions = {}): ClassDecorator & MethodDecorator {
  return (target: object, _key?: string | symbol, descriptor?: PropertyDescriptor) => {
    const holder = descriptor ? (descriptor.value as object) : target;
    const existing: AbilityRequirement[] = Reflect.getMetadata(CHECK_ABILITY_METADATA, holder) ?? [];
    Reflect.defineMetadata(CHECK_ABILITY_METADATA, [{ action, subject, options }, ...existing], holder);
  };
}

/**
 * External grants mode: the user must hold **any one** of `keys` (roles, or keys they inherit)
 * anywhere in the request domain. Stack several to require all of them. Works on controllers and
 * methods. Answers 403 with the missing keys, or 404 for users with no access to the domain when
 * `onNoDomainAccess: 'not-found'` is set.
 *
 * @example
 * ```ts
 * @Get()
 * @RequirePermission('site.read', 'site.manage')
 * list() {}
 * ```
 */
export function RequirePermission(...keys: string[]): ClassDecorator & MethodDecorator {
  if (keys.length === 0 || keys.some((k) => typeof k !== 'string' || !k)) {
    throw new Error('@RequirePermission needs at least one non-empty key');
  }
  return (target: object, _key?: string | symbol, descriptor?: PropertyDescriptor) => {
    const holder = descriptor ? (descriptor.value as object) : target;
    const existing: string[][] = Reflect.getMetadata(REQUIRE_PERMISSION_METADATA, holder) ?? [];
    Reflect.defineMetadata(REQUIRE_PERMISSION_METADATA, [[...keys], ...existing], holder);
  };
}

/**
 * Injects the current request's `Ability` (set by {@link AuthzGuard}).
 * @example findAll(@CurrentAbility() ability: Ability) {}
 */
export const CurrentAbility = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const request = getRequest(context);
  return request?.[REQUEST_ABILITY];
});
