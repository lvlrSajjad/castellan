import { BaseEntity, Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** Shape of a policy row entity (compatible with `typeorm-adapter`). */
export interface PolicyRuleRow extends BaseEntity {
  id: number;
  ptype: string;
  v0: string;
  v1: string;
  v2: string;
  v3: string;
  v4: string;
  v5: string;
  v6: string;
}

export type PolicyRuleEntity = new () => PolicyRuleRow;

/**
 * Creates the policy table entity (same columns as `typeorm-adapter`'s `casbin_rule`). Unlike that entity,
 * value columns are `text`, because condition JSON easily exceeds `varchar(255)`.
 *
 * Add the returned class to your DataSource `entities` (and generate a migration for it).
 */
export function createPolicyRuleEntity(tableName = 'castellan_rule'): PolicyRuleEntity {
  class CastellanRule extends BaseEntity {}
  Entity(tableName)(CastellanRule);
  PrimaryGeneratedColumn('increment', { type: 'integer' })(CastellanRule.prototype, 'id');
  Column({ type: 'varchar', length: 16, nullable: true })(CastellanRule.prototype, 'ptype');
  for (const key of ['v0', 'v1', 'v2', 'v3', 'v4', 'v5', 'v6']) {
    Column({ type: 'text', nullable: true })(CastellanRule.prototype, key);
  }
  return CastellanRule as unknown as PolicyRuleEntity;
}

/** Default policy entity, stored in the `castellan_rule` table. */
export const CastellanRule = createPolicyRuleEntity();
