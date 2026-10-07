import { ALL, ANY, MANAGE, type Rule } from './rule.js';

function overlaps(a: string, b: string, wildcard: string): boolean {
  return a === b || a === wildcard || b === wildcard;
}

function describe(rule: Rule): string {
  const verb = rule.effect === 'allow' ? 'can' : 'cannot';
  const who = rule.principal === ANY ? 'everyone' : `role(${rule.principal})`;
  return `${who}.${verb}('${rule.action}', '${rule.subject}'${rule.conditions ? ', {…}' : ''})`;
}

/**
 * Flags rules that can never take effect under castellan's "any deny wins" semantics:
 * an unconditional `cannot` makes every overlapping `can` dead, regardless of declaration order.
 * (In CASL a later `can` would override an earlier `cannot`; here it does not.)
 */
export function lintRules(rules: readonly Rule[]): string[] {
  const warnings: string[] = [];
  const blanketDenies = rules.filter((r) => r.effect === 'deny' && !r.conditions && !r.fields);
  for (const allow of rules) {
    if (allow.effect !== 'allow') continue;
    const shadow = blanketDenies.find(
      (deny) =>
        (deny.principal === ANY || deny.principal === allow.principal) &&
        overlaps(deny.domain, allow.domain, ANY) &&
        (deny.action === allow.action || deny.action === MANAGE) &&
        (deny.subject === allow.subject || deny.subject === ALL),
    );
    if (shadow) {
      warnings.push(
        `${describe(allow)} can never match: ${describe(shadow)} denies it unconditionally ` +
          '(any matching deny wins, regardless of order).',
      );
    }
  }
  return warnings;
}
