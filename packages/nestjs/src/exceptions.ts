import { ForbiddenException } from '@nestjs/common';

export interface AuthzForbiddenDetails {
  action: string;
  subjectType: string;
  field?: string;
  /** Reason attached to the deny rule with `.because()`, if any. */
  reason?: string;
}

/** 403 raised by castellan. The response body includes the rule's reason when there is one. */
export class AuthzForbiddenException extends ForbiddenException {
  constructor(readonly details: AuthzForbiddenDetails) {
    super({
      statusCode: 403,
      error: 'Forbidden',
      message: details.reason ?? `You are not allowed to ${details.action} ${details.subjectType}`,
      action: details.action,
      subject: details.subjectType,
      ...(details.field ? { field: details.field } : {}),
    });
  }
}

/** 403 raised by `@RequirePermission` when the user holds none of the keys in the request domain. */
export class PermissionRequiredException extends ForbiddenException {
  constructor(readonly permissions: readonly string[]) {
    super({
      statusCode: 403,
      error: 'Forbidden',
      message: `Missing permission: ${permissions.join(' or ')}`,
      permissions: [...permissions],
    });
  }
}
