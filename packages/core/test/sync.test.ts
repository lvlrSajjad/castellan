import { describe, expect, it } from 'vitest';
import { Authz, buildModelText, definePolicies } from '../src/index.js';

const v1 = definePolicies(({ role, everyone }) => {
  everyone.can('read', 'Doc');
  role('editor').can('update', 'Doc', { locked: false });
});
const v2 = definePolicies(({ role, everyone }) => {
  everyone.can('read', 'Doc');
  role('editor').can('update', 'Doc', { locked: { $ne: true } });
  role('editor').inherits('viewer');
});

describe('syncPolicies', () => {
  it('replaces code rules and leaves runtime grants alone', async () => {
    const authz = await Authz.create({ policies: v1, logger: false });
    await authz.grant(definePolicies(({ role }) => role('editor').can('delete', 'Doc')));

    const dry = await authz.syncPolicies(v2, 'dry-run');
    expect(dry.added).toHaveLength(1);
    expect(dry.removed).toHaveLength(1);
    expect(await authz.listRules()).toHaveLength(3);

    const report = await authz.syncPolicies(v2, 'replace');
    expect(report).toMatchObject({ unchanged: 1, addedRoleLinks: [{ member: 'editor', role: 'viewer', domain: '*' }] });
    const rules = await authz.listRules();
    expect(rules.map((r) => `${r.origin}:${r.principal}:${r.action}`).sort()).toEqual([
      'code:*:read',
      'code:editor:update',
      'runtime:editor:delete',
    ]);
    expect(rules.find((r) => r.action === 'update')?.conditions).toEqual({ locked: { $ne: true } });
  });

  it('merge mode only adds', async () => {
    const authz = await Authz.create({ policies: v1, logger: false });
    const report = await authz.syncPolicies(v2, 'merge');
    expect(report.removed).toHaveLength(0);
    expect(await authz.listRules()).toHaveLength(3);
  });

  it('is idempotent', async () => {
    const authz = await Authz.create({ policies: v2, logger: false });
    const report = await authz.syncPolicies(v2);
    expect(report).toMatchObject({ added: [], removed: [], unchanged: 2, addedRoleLinks: [] });
  });

  it('grant and revoke round-trip', async () => {
    const authz = await Authz.create({ logger: false });
    const extra = definePolicies(({ role }) => role('editor').can('publish', 'Doc', { ownerId: 'x' }));
    expect(await authz.grant(extra)).toHaveLength(1);
    expect(await authz.grant(extra)).toHaveLength(0);
    expect(await authz.revoke(extra)).toHaveLength(1);
    expect(await authz.listRules()).toHaveLength(0);
  });
});

describe('lint', () => {
  it('warns when an unconditional deny shadows an allow', () => {
    const set = definePolicies(({ role, everyone }) => {
      everyone.cannot('delete', 'Doc');
      role('owner').can('delete', 'Doc', { ownerId: 'x' });
    });
    expect(set.warnings).toHaveLength(1);
    expect(set.warnings[0]).toMatch(/can never match/);
  });
});

describe('export', () => {
  it('exports Casbin CSV with JSON conditions quoted', async () => {
    const authz = await Authz.create({ policies: v1, logger: false });
    await authz.assignRole('alice', 'editor', 'org-1');
    const csv = await authz.exportPolicies();
    expect(csv).toContain('p, editor, *, Doc, update, "{""__origin"":""code"",""locked"":false}", allow');
    expect(csv).toContain('g, alice, editor, org-1');
  });

  it('generates both model variants from one template', () => {
    expect(buildModelText()).toContain('r = sub, dom, obj, act');
    expect(buildModelText({ domains: false })).toContain('r = sub, obj, act');
    expect(buildModelText({ domains: false })).not.toContain('r.dom');
  });
});
