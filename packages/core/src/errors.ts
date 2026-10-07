/** Base class for every error thrown by castellan. */
export class CastellanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** A condition object uses an unsupported operator, an invalid field name, or a malformed value. */
export class ConditionError extends CastellanError {}

/** A subject's type could not be detected (e.g. a plain object without `__type`). */
export class SubjectTypeError extends CastellanError {}

/**
 * A `$ref` in a condition points at a user attribute that is `undefined`.
 * Evaluation treats this fail-closed: allow rules do not match, deny rules do.
 */
export class UnresolvedRefError extends CastellanError {
  constructor(readonly ref: string) {
    super(`Reference "${ref}" resolved to undefined`);
  }
}

/** Thrown by `assert()` when access is denied. Carries the deny rule's reason when there is one. */
export class ForbiddenError extends CastellanError {
  constructor(
    message: string,
    readonly details: { action: string; subjectType: string; field?: string; reason?: string },
  ) {
    super(message);
  }
}
