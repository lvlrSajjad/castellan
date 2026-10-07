import { CastellanError, ScopeMappingError, ScopeTooLargeError } from './errors.js';

/** The root scope: contains every other scope. */
export const ROOT_SCOPE = '*';

/** A leaf id as stored in the subject's leaf column (e.g. a site id). */
export type LeafId = string | number;

/**
 * The app's resource hierarchy (platform → partner → tenant → group → site …), as seen by castellan.
 * Scope keys are opaque strings such as `'org:812'` or `'site:1001'`; castellan never parses them.
 */
export interface ScopeTree {
  /** True when `inner` is `outer` or below it. `*` contains everything. Must be synchronous. */
  contains(outer: string, inner: string): boolean;
  /** Leaf ids at or under a scope, e.g. the site ids under a group or an org. */
  leaves(scope: string): readonly LeafId[];
}

/** One node of a {@link createScopeTree} input. */
export interface ScopeNode {
  key: string;
  /** Parent scope key. Omit (or `null`) for top-level nodes; they sit under `*`. */
  parent?: string | null;
  /** Set on leaf nodes: the id stored in subjects' leaf column (e.g. the site id). */
  leaf?: LeafId;
}

/** Builds a scope key, e.g. `scopeKey('site', 1001)` → `'site:1001'`. Optional convenience. */
export function scopeKey(kind: string, id: string | number): string {
  return `${kind}:${id}`;
}

/**
 * Builds a {@link ScopeTree} from parent links. Leaf lists are computed once per scope and memoized.
 *
 * @example
 * ```ts
 * const tree = createScopeTree([
 *   { key: 'org:812' },
 *   { key: 'group:north', parent: 'org:812' },
 *   { key: 'site:1001', parent: 'group:north', leaf: 1001 },
 * ]);
 * ```
 */
export function createScopeTree(nodes: Iterable<ScopeNode>): ScopeTree {
  const parent = new Map<string, string | null>();
  const leafOf = new Map<string, LeafId>();
  const children = new Map<string, string[]>();
  for (const node of nodes) {
    if (!node.key || node.key === ROOT_SCOPE) throw new CastellanError(`Invalid scope key "${node.key}"`);
    if (parent.has(node.key)) throw new CastellanError(`Duplicate scope key "${node.key}"`);
    parent.set(node.key, node.parent ?? null);
    if (node.leaf !== undefined && node.leaf !== null) leafOf.set(node.key, node.leaf);
  }
  for (const [key, p] of parent) {
    const list = children.get(p ?? ROOT_SCOPE) ?? [];
    list.push(key);
    children.set(p ?? ROOT_SCOPE, list);
  }
  const leafCache = new Map<string, LeafId[]>();

  const contains = (outer: string, inner: string): boolean => {
    if (outer === ROOT_SCOPE || outer === inner) return true;
    let current = parent.get(inner);
    for (let depth = 0; current && depth < 64; depth++) {
      if (current === outer) return true;
      current = parent.get(current);
    }
    return false;
  };

  const leaves = (scope: string): LeafId[] => {
    const cached = leafCache.get(scope);
    if (cached) return cached;
    const out: LeafId[] = [];
    const stack = [scope];
    const seen = new Set<string>();
    while (stack.length) {
      const key = stack.pop()!;
      if (seen.has(key)) continue;
      seen.add(key);
      const leaf = leafOf.get(key);
      if (leaf !== undefined) out.push(leaf);
      const kids = children.get(key) ?? [];
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!); // keep tree order
    }
    leafCache.set(scope, out);
    return out;
  };

  return { contains, leaves };
}

/** How one subject type maps onto the scope tree. */
export interface SubjectScope {
  /** Column holding the tenant id (compared with the request domain). Omit if the subject has none. */
  tenant?: string;
  /** Column holding the leaf id (compared with `ScopeTree.leaves`). Required for sub-tenant scopes. */
  leaf?: string;
}

export interface SubjectMapOptions {
  /**
   * Maps a request domain (a scope key, e.g. `'org:812'`) to the value stored in tenant columns.
   * Default: the part after the last `:`, as a number when it is all digits (`'org:812'` → `812`).
   */
  tenantValue?: (domain: string) => LeafId;
}

/** Output of {@link defineSubjects}. */
export interface SubjectMap {
  readonly subjects: Readonly<Record<string, SubjectScope>>;
  readonly tenantValue: (domain: string) => LeafId;
}

const COLUMN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Default domain → tenant value mapping. */
export function defaultTenantValue(domain: string): LeafId {
  const id = domain.includes(':') ? domain.slice(domain.lastIndexOf(':') + 1) : domain;
  return /^\d+$/.test(id) && id.length < 16 ? Number(id) : id;
}

/**
 * Declares how each subject type maps onto the scope tree. Columns must be root fields of the
 * subject (no relation paths), so scope filters never add joins.
 *
 * @example
 * ```ts
 * export const subjects = defineSubjects({
 *   Site:      { tenant: 'orgId', leaf: 'id' },
 *   WorkOrder: { tenant: 'orgId', leaf: 'siteId' },
 *   Reading:   { leaf: 'siteId' },   // no tenant column
 * });
 * ```
 */
export function defineSubjects(
  subjects: Record<string, SubjectScope>,
  options: SubjectMapOptions = {},
): SubjectMap {
  for (const [type, scope] of Object.entries(subjects)) {
    if (!scope.tenant && !scope.leaf) throw new CastellanError(`Subject "${type}" needs a tenant or a leaf column`);
    for (const column of [scope.tenant, scope.leaf]) {
      if (column !== undefined && !COLUMN.test(column)) {
        throw new CastellanError(`Invalid column "${column}" for subject "${type}" (root fields only)`);
      }
    }
  }
  return { subjects: { ...subjects }, tenantValue: options.tenantValue ?? defaultTenantValue };
}

/** Looks up a subject's scope mapping, throwing {@link ScopeMappingError} if there is none. */
export function requireSubjectScope(map: SubjectMap, type: string): SubjectScope {
  const scope = map.subjects[type];
  if (!scope) {
    throw new ScopeMappingError(
      `Subject "${type}" has no entry in the subject map, so it cannot be checked against a scope. ` +
        'Add it to defineSubjects().',
    );
  }
  return scope;
}

/** Returns the leaves of a scope as a string set, enforcing `max`. */
export function leafSet(tree: ScopeTree, scope: string, max: number): Set<string> {
  const leaves = tree.leaves(scope);
  if (leaves.length > max) {
    throw new ScopeTooLargeError(`Scope "${scope}" has ${leaves.length} leaves, more than maxScopeLeaves (${max})`);
  }
  return new Set(leaves.map(String));
}
