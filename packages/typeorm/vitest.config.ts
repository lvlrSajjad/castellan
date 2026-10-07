import { defineConfig, mergeConfig } from 'vitest/config';
import shared from '../../vitest.shared.js';

// Test files share one Postgres/MySQL database and drop its schema, so run them one at a time there.
const sharedDatabase = Boolean(process.env.CASTELLAN_PG_URL || process.env.CASTELLAN_MYSQL_URL);

export default mergeConfig(shared, defineConfig({ test: { fileParallelism: !sharedDatabase } }));
