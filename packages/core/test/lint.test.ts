import { describe, expect, it } from 'vitest';
import { type Rule, lintRules } from '../src/index.js';

const rule = (overrides: Partial<Rule>): Rule => ({
  principal: '*',
  domain: '*',
  action: 'read',
  subject: 'WorkOrder',
  effect: 'allow',
  ...overrides,
});

describe('lintRules', () => {
  it('returns no warnings when there is no shadowing', () => {
    const rules = [rule({ effect: 'allow' }), rule({ effect: 'deny', conditions: { status: 'closed' } })];
    expect(lintRules(rules)).toEqual([]);
  });

  it('flags an allow shadowed by an unconditional deny for everyone on the same subject and action', () => {
    const rules = [rule({ principal: 'tech', effect: 'allow' }), rule({ principal: '*', effect: 'deny' })];
    const warnings = lintRules(rules);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/can never match/);
  });

  it('flags an allow shadowed by a deny naming the exact same principal', () => {
    const rules = [rule({ principal: 'tech', effect: 'allow' }), rule({ principal: 'tech', effect: 'deny' })];
    expect(lintRules(rules)).toHaveLength(1);
  });

  it('does not flag when the deny is scoped to a different principal', () => {
    const rules = [rule({ principal: 'tech', effect: 'allow' }), rule({ principal: 'manager', effect: 'deny' })];
    expect(lintRules(rules)).toEqual([]);
  });

  it('does not flag when the deny domain does not overlap', () => {
    const rules = [rule({ domain: 'org-1', effect: 'allow' }), rule({ domain: 'org-2', effect: 'deny' })];
    expect(lintRules(rules)).toEqual([]);
  });

  it('treats a deny with manage action as shadowing any action', () => {
    const rules = [rule({ action: 'update', effect: 'allow' }), rule({ action: 'manage', effect: 'deny' })];
    expect(lintRules(rules)).toHaveLength(1);
  });

  it('treats a deny on all subjects as shadowing any subject', () => {
    const rules = [rule({ subject: 'Invoice', effect: 'allow' }), rule({ subject: 'all', effect: 'deny' })];
    expect(lintRules(rules)).toHaveLength(1);
  });

  it('does not treat a conditional deny as a blanket deny', () => {
    const rules = [rule({ effect: 'allow' }), rule({ effect: 'deny', conditions: { status: 'closed' } })];
    expect(lintRules(rules)).toEqual([]);
  });

  it('does not treat a field-scoped deny as a blanket deny', () => {
    const rules = [rule({ effect: 'allow' }), rule({ effect: 'deny', fields: ['amount'] })];
    expect(lintRules(rules)).toEqual([]);
  });

  it('does not surface the deny rule\'s reason in the warning text', () => {
    const rules = [rule({ effect: 'allow' }), rule({ effect: 'deny', reason: 'blocked' })];
    const warnings = lintRules(rules);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toMatch(/blocked/);
  });
});