import { type Enforcer, newEnforcer } from 'casbin';
import { type GrantContext } from './grants.js';
import { buildModel, registerMatchers } from './model.js';
import { ANY, ruleToRow } from './rule.js';
import { ROOT_SCOPE, type ScopeTree, leafSet } from './scope.js';

/**
 * Request domain encoding for scoped enforcers. Type-level checks pass the plain domain; instance
 * checks pass `{"d": domain, "l": leafValue}` so the role-link matcher can test the instance's leaf.
 */
export function encodeScopedDomain(domain: string, instance: boolean, leaf: unknown): string {
  if (!instance) return domain;
  return JSON.stringify({ d: domain, l: leaf === null || leaf === undefined ? null : String(leaf) });
}

function decode(name: string): { domain: string; instance: boolean; leaf: string | null } {
  if (name.startsWith('{')) {
    const parsed = JSON.parse(name) as { d: string; l: string | null };
    return { domain: parsed.d, instance: true, leaf: parsed.l };
  }
  return { domain: name, instance: false, leaf: null };
}

/**
 * Role-link domain matcher for scoped RBAC. A link stored at assignment scope `S` applies when
 * `S` contains the domain, or when `S` is inside the domain and — for instance checks — the
 * instance's leaf is under `S`.
 */
export function createScopeDomainMatcher(tree: ScopeTree, maxScopeLeaves: number) {
  const decoded = new Map<string, ReturnType<typeof decode>>();
  const leaves = new Map<string, Set<string>>();
  return (requestDomain: string, linkScope: string): boolean => {
    if (linkScope === ANY || linkScope === ROOT_SCOPE) return true;
    let request = decoded.get(requestDomain);
    if (!request) {
      request = decode(requestDomain);
      if (decoded.size > 10_000) decoded.clear();
      decoded.set(requestDomain, request);
    }
    if (tree.contains(linkScope, request.domain)) return true;
    if (!tree.contains(request.domain, linkScope)) return false;
    if (!request.instance) return true;
    if (request.leaf === null) return false;
    let set = leaves.get(linkScope);
    if (!set) {
      set = leafSet(tree, linkScope, maxScopeLeaves);
      leaves.set(linkScope, set);
    }
    return set.has(request.leaf);
  };
}

/** Builds an in-memory Casbin enforcer for one grant context (no adapter, nothing persisted). */
export async function buildScopedEnforcer(context: GrantContext, tree: ScopeTree, maxScopeLeaves: number): Promise<Enforcer> {
  const enforcer = await newEnforcer(buildModel({ domains: true }));
  enforcer.enableAutoSave(false);
  await registerMatchers(enforcer, { domains: true, domainMatcher: createScopeDomainMatcher(tree, maxScopeLeaves) });
  const rows = new Map<string, string[]>();
  for (const rule of context.rules) {
    const row = ruleToRow(rule, true);
    rows.set(JSON.stringify(row), row);
  }
  if (rows.size) await enforcer.addPolicies([...rows.values()]);
  const links = new Map<string, string[]>();
  for (const link of context.links) links.set(JSON.stringify(link), link);
  if (links.size) await enforcer.addGroupingPolicies([...links.values()]);
  return enforcer;
}
