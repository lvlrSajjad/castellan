import { type Enforcer, type RoleManager, newEnforcer } from 'casbin';
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

type DomainMatcher = (requestDomain: string, linkDomain: string) => boolean;
type Graph = Map<string, Set<string>>;

const MERGED_CACHE_LIMIT = 1_000;

/**
 * Casbin role manager for scoped enforcers. Same semantics as Casbin's default role manager with a
 * domain-matching function (a link applies when its domain is the request domain or matches it),
 * but it keeps the merged role graph per request domain instead of rebuilding it on every `g()`
 * call. Any link change clears the cache.
 */
export class ScopedRoleManager implements RoleManager {
  private readonly links = new Map<string, Graph>();
  private readonly merged = new Map<string, Graph>();

  constructor(
    private matcher: DomainMatcher,
    private readonly maxHierarchyLevel = 10,
  ) {}

  /** Called by `enforcer.addNamedDomainMatchingFunc`. */
  async addDomainMatchingFunc(fn: DomainMatcher): Promise<void> {
    this.matcher = fn;
    this.merged.clear();
  }

  async clear(): Promise<void> {
    this.links.clear();
    this.merged.clear();
  }

  async addLink(name1: string, name2: string, ...domain: string[]): Promise<void> {
    const graph = this.links.get(domain[0] ?? '') ?? new Map<string, Set<string>>();
    this.links.set(domain[0] ?? '', graph);
    const roles = graph.get(name1) ?? new Set<string>();
    roles.add(name2);
    graph.set(name1, roles);
    this.merged.clear();
  }

  async deleteLink(name1: string, name2: string, ...domain: string[]): Promise<void> {
    this.links.get(domain[0] ?? '')?.get(name1)?.delete(name2);
    this.merged.clear();
  }

  syncedHasLink(name1: string, name2: string, ...domain: string[]): boolean {
    if (name1 === name2) return true;
    const graph = this.graph(domain[0] ?? '');
    let frontier = [name1];
    const seen = new Set(frontier);
    for (let level = 0; level < this.maxHierarchyLevel && frontier.length; level++) {
      const next: string[] = [];
      for (const name of frontier) {
        for (const role of graph.get(name) ?? []) {
          if (role === name2) return true;
          if (!seen.has(role)) {
            seen.add(role);
            next.push(role);
          }
        }
      }
      frontier = next;
    }
    return false;
  }

  async hasLink(name1: string, name2: string, ...domain: string[]): Promise<boolean> {
    return this.syncedHasLink(name1, name2, ...domain);
  }

  async getRoles(name: string, ...domain: string[]): Promise<string[]> {
    return [...(this.graph(domain[0] ?? '').get(name) ?? [])];
  }

  async getUsers(name: string, ...domain: string[]): Promise<string[]> {
    return [...this.graph(domain[0] ?? '')].filter(([, roles]) => roles.has(name)).map(([member]) => member);
  }

  async printRoles(): Promise<void> {}

  async getDomains(name: string): Promise<string[]> {
    return [...this.links].filter(([, graph]) => graph.has(name)).map(([domain]) => domain);
  }

  async getAllDomains(): Promise<string[]> {
    return [...this.links.keys()];
  }

  /** The links that apply in a request domain, merged into one graph and cached. */
  private graph(requestDomain: string): Graph {
    const cached = this.merged.get(requestDomain);
    if (cached) return cached;
    const graph: Graph = new Map();
    for (const [linkDomain, links] of this.links) {
      if (linkDomain !== requestDomain && !this.matcher(requestDomain, linkDomain)) continue;
      for (const [member, roles] of links) {
        const merged = graph.get(member) ?? new Set<string>();
        for (const role of roles) merged.add(role);
        graph.set(member, merged);
      }
    }
    if (this.merged.size >= MERGED_CACHE_LIMIT) this.merged.clear();
    this.merged.set(requestDomain, graph);
    return graph;
  }
}

/** Builds an in-memory Casbin enforcer for one grant context (no adapter, nothing persisted). */
export async function buildScopedEnforcer(context: GrantContext, tree: ScopeTree, maxScopeLeaves: number): Promise<Enforcer> {
  const enforcer = await newEnforcer(buildModel({ domains: true }));
  enforcer.enableAutoSave(false);
  enforcer.enableAutoBuildRoleLinks(false);
  const matcher = createScopeDomainMatcher(tree, maxScopeLeaves);
  enforcer.setRoleManager(new ScopedRoleManager(matcher));
  await registerMatchers(enforcer, { domains: true, domainMatcher: matcher });
  const rows = new Map<string, string[]>();
  for (const rule of context.rules) {
    const row = ruleToRow(rule, true);
    rows.set(JSON.stringify(row), row);
  }
  if (rows.size) await enforcer.addPolicies([...rows.values()]);
  const links = new Map<string, string[]>();
  for (const link of context.links) links.set(JSON.stringify(link), link);
  if (links.size) await enforcer.addGroupingPolicies([...links.values()]);
  await enforcer.buildRoleLinks();
  return enforcer;
}
