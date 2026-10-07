import { type BatchAdapter, type Model } from 'casbin';
import { type DataSource, type EntityManager, type FindOptionsWhere, IsNull } from 'typeorm';
import { CastellanRule, type PolicyRuleEntity, type PolicyRuleRow } from './entity.js';

const VALUE_KEYS = ['v0', 'v1', 'v2', 'v3', 'v4', 'v5', 'v6'] as const;

export interface TypeormAdapterOptions {
  /** Policy entity; must be registered in the DataSource. Default {@link CastellanRule}. */
  entity?: PolicyRuleEntity;
}

/**
 * Casbin adapter that stores policies through an existing TypeORM `DataSource` (no second connection).
 *
 * The table layout (`ptype`, `v0`…`v6`) matches `typeorm-adapter`'s `casbin_rule`, so data can move
 * between the two. castellan ships its own adapter because `typeorm-adapter` 1.10 corrupts JSON
 * conditions on load (it rebuilds a CSV line without escaping quotes) and requires `mongodb` at
 * import time. See docs/decisions/002-own-typeorm-adapter.md.
 */
export class TypeormAdapter implements BatchAdapter {
  private readonly entity: PolicyRuleEntity;

  constructor(
    private readonly dataSource: DataSource,
    options: TypeormAdapterOptions = {},
  ) {
    this.entity = options.entity ?? CastellanRule;
  }

  async loadPolicy(model: Model): Promise<void> {
    await this.ensureInitialized();
    const rows = await this.dataSource.getRepository(this.entity).find({ order: { id: 'ASC' } });
    for (const row of rows) {
      if (!row.ptype) continue;
      const values = VALUE_KEYS.map((k) => row[k] as string | null | undefined);
      while (values.length && (values[values.length - 1] === null || values[values.length - 1] === undefined)) {
        values.pop();
      }
      model.addPolicy(row.ptype.substring(0, 1), row.ptype, values.map((v) => v ?? ''));
    }
  }

  async savePolicy(model: Model): Promise<boolean> {
    await this.ensureInitialized();
    const rows: Partial<PolicyRuleRow>[] = [];
    for (const sec of ['p', 'g']) {
      const assertions = model.model.get(sec);
      if (!assertions) continue;
      for (const [ptype, assertion] of assertions) {
        for (const rule of assertion.policy) rows.push(this.toRow(ptype, rule));
      }
    }
    await this.dataSource.transaction(async (manager) => {
      await manager.getRepository(this.entity).clear();
      if (rows.length) await manager.getRepository(this.entity).insert(rows as never);
    });
    return true;
  }

  async addPolicy(_sec: string, ptype: string, rule: string[]): Promise<void> {
    await this.addPolicies(_sec, ptype, [rule]);
  }

  async addPolicies(_sec: string, ptype: string, rules: string[][]): Promise<void> {
    if (!rules.length) return;
    await this.ensureInitialized();
    await this.dataSource.getRepository(this.entity).insert(rules.map((rule) => this.toRow(ptype, rule)) as never);
  }

  async removePolicy(_sec: string, ptype: string, rule: string[]): Promise<void> {
    await this.removePolicies(_sec, ptype, [rule]);
  }

  async removePolicies(_sec: string, ptype: string, rules: string[][]): Promise<void> {
    if (!rules.length) return;
    await this.ensureInitialized();
    await this.dataSource.transaction(async (manager) => {
      for (const rule of rules) await this.deleteWhere(manager, this.exactWhere(ptype, rule));
    });
  }

  async removeFilteredPolicy(_sec: string, ptype: string, fieldIndex: number, ...fieldValues: string[]): Promise<void> {
    await this.ensureInitialized();
    const where: Record<string, unknown> = { ptype };
    fieldValues.forEach((value, i) => {
      const key = VALUE_KEYS[fieldIndex + i];
      if (key && value) where[key] = value;
    });
    await this.deleteWhere(this.dataSource.manager, where as FindOptionsWhere<PolicyRuleRow>);
  }

  private toRow(ptype: string, rule: string[]): Partial<PolicyRuleRow> {
    const row: Record<string, string> = { ptype };
    rule.forEach((value, i) => {
      const key = VALUE_KEYS[i];
      if (key) row[key] = value;
    });
    return row as Partial<PolicyRuleRow>;
  }

  private exactWhere(ptype: string, rule: string[]): FindOptionsWhere<PolicyRuleRow> {
    const where: Record<string, unknown> = { ptype };
    VALUE_KEYS.forEach((key, i) => {
      where[key] = i < rule.length ? rule[i] : IsNull();
    });
    return where as FindOptionsWhere<PolicyRuleRow>;
  }

  private async deleteWhere(manager: EntityManager, where: FindOptionsWhere<PolicyRuleRow>): Promise<void> {
    await manager.getRepository(this.entity).delete(where);
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.dataSource.isInitialized) await this.dataSource.initialize();
  }
}

/** Creates a {@link TypeormAdapter} on an existing DataSource. */
export function createTypeormAdapter(dataSource: DataSource, options: TypeormAdapterOptions = {}): TypeormAdapter {
  return new TypeormAdapter(dataSource, options);
}
