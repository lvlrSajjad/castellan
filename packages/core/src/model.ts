import { newModelFromString, type Enforcer, type Model } from 'casbin';
import { type RequestObject, actionMatches, compileCond, condMatches, ANY, subjectMatches } from './rule.js';

export interface ModelOptions {
  /** Multi-tenant model with a domain field on requests, policies and role links. Default `true`. */
  domains?: boolean;
  /**
   * Domain matching for role links, `(requestDomain, linkDomain) => boolean`.
   * Default: a link in domain `*` applies everywhere, otherwise domains must be equal.
   */
  domainMatcher?: (requestDomain: string, linkDomain: string) => boolean;
}

/**
 * Generates the Casbin model text castellan ships. Users never write `model.conf`.
 *
 * - `p.cond` holds the JSON condition; `p.eft` is `allow` / `deny`; any matching deny wins.
 * - `p.sub == "*"` matches every principal; `p.dom == "*"` matches every domain.
 * - Role links stored in domain `*` apply in every domain.
 */
export function buildModelText({ domains = true }: ModelOptions = {}): string {
  const dom = domains ? ' dom,' : '';
  const gDom = domains ? ', r.dom' : '';
  const domMatch = domains ? ` && (p.dom == "${ANY}" || r.dom == p.dom)` : '';
  return [
    '[request_definition]',
    `r = sub,${dom} obj, act`,
    '',
    '[policy_definition]',
    `p = sub,${dom} obj, act, cond, eft`,
    '',
    '[role_definition]',
    domains ? 'g = _, _, _' : 'g = _, _',
    '',
    '[policy_effect]',
    'e = some(where (p.eft == allow)) && !some(where (p.eft == deny))',
    '',
    '[matchers]',
    `m = (p.sub == "${ANY}" || g(r.sub, p.sub${gDom}))${domMatch} && subjectMatch(r.obj, p.obj) && actionMatch(r.act, p.act) && condMatch(r.obj, p.cond, p.eft)`,
    '',
  ].join('\n');
}

/** Builds the Casbin `Model` object. */
export function buildModel(options?: ModelOptions): Model {
  return newModelFromString(buildModelText(options));
}

/**
 * Registers castellan's matcher functions (`subjectMatch`, `actionMatch`, `condMatch`) and the
 * `*` domain wildcard for role links on an enforcer built from {@link buildModel}.
 */
export async function registerMatchers(enforcer: Enforcer, { domains = true, domainMatcher }: ModelOptions = {}): Promise<void> {
  await enforcer.addFunction('subjectMatch', ((obj: RequestObject, ruleSubject: string) =>
    subjectMatches(obj.type, ruleSubject)) as never);
  await enforcer.addFunction('actionMatch', ((act: string, ruleAction: string) =>
    actionMatches(act, ruleAction)) as never);
  await enforcer.addFunction('condMatch', ((obj: RequestObject, cond: string, eft: string) =>
    condMatches(obj, compileCond(cond), eft === 'deny' ? 'deny' : 'allow')) as never);
  if (domains) {
    await enforcer.addNamedDomainMatchingFunc(
      'g',
      domainMatcher ?? ((name: string, pattern: string) => pattern === ANY || name === pattern),
    );
  }
}
