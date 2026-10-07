import { SubjectTypeError } from './errors.js';

/** Any class, including abstract ones (TypeORM entities, DTOs). */
export type AnyClass<T = any> = abstract new (...args: any[]) => T;

/** A subject type: a class, or a string name. `'all'` matches every subject type. */
export type SubjectType = string | AnyClass;

/** Key used to tag plain objects with their subject type. */
export const SUBJECT_TYPE_KEY = '__type';

/** Function that maps an instance to its subject type name. */
export type DetectSubjectType = (subject: object) => string | undefined;

/**
 * Returns the subject type name for a class or string.
 * Classes may override their name with a static `modelName` (useful when code is minified).
 */
export function subjectTypeName(type: SubjectType): string {
  if (typeof type === 'string') return type;
  const modelName = (type as { modelName?: unknown }).modelName;
  if (typeof modelName === 'string' && modelName) return modelName;
  if (!type.name) throw new SubjectTypeError('Anonymous classes cannot be used as subject types; add a static modelName');
  return type.name;
}

/**
 * Tags a plain object (e.g. a DTO or a raw query row) with a subject type so it can be checked.
 * @example ability.can('update', subject('WorkOrder', dto))
 */
export function subject<T extends object>(type: SubjectType, object: T): T {
  Object.defineProperty(object, SUBJECT_TYPE_KEY, { value: subjectTypeName(type), enumerable: false, configurable: true });
  return object;
}

/**
 * Default detection: the `__type` tag, else a static `modelName`, else the constructor name.
 * Plain objects without a tag are rejected instead of silently becoming `'Object'`.
 */
export const defaultDetectSubjectType: DetectSubjectType = (object) => {
  const tagged = (object as Record<string, unknown>)[SUBJECT_TYPE_KEY];
  if (typeof tagged === 'string') return tagged;
  const ctor = (object as { constructor?: AnyClass }).constructor;
  if (!ctor || ctor === Object) return undefined;
  return subjectTypeName(ctor);
};

/** Resolves the type name of a subject passed to `can()`: a type, or an instance. */
export function resolveSubject(
  subject: SubjectType | object,
  detect: DetectSubjectType = defaultDetectSubjectType,
): { type: string; data?: object } {
  if (typeof subject === 'string' || typeof subject === 'function') {
    return { type: subjectTypeName(subject as SubjectType) };
  }
  const type = detect(subject) ?? defaultDetectSubjectType(subject);
  if (!type) {
    throw new SubjectTypeError(
      'Cannot detect the subject type of a plain object. Wrap it with subject("Type", obj), ' +
        'pass an entity instance, or configure detectSubjectType.',
    );
  }
  return { type, data: subject };
}
