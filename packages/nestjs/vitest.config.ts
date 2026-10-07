import swc from 'unplugin-swc';
import { defineConfig, mergeConfig } from 'vitest/config';
import shared from '../../vitest.shared.js';

// SWC emits decorator metadata, which Nest needs for constructor injection in test fixtures.
export default mergeConfig(shared, defineConfig({ plugins: [swc.vite({ module: { type: 'es6' } })] }));
