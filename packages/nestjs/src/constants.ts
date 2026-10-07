/** Injection token for the resolved module options. */
export const AUTHZ_MODULE_OPTIONS = Symbol('castellan:module-options');
/** Injection token for the core `Authz` instance. */
export const AUTHZ_INSTANCE = Symbol('castellan:authz');
/** Metadata key for `@CheckAbility` requirements. */
export const CHECK_ABILITY_METADATA = 'castellan:check-ability';
/** Request property where the guard stores the user's ability. */
export const REQUEST_ABILITY = Symbol.for('castellan:ability');
