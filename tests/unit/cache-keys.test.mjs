import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from '../helpers/load-ts.mjs';
import { createBaseTemplate } from '../helpers/fixtures.mjs';

const { buildCacheKey, buildBlockCacheId } = loadTs('../../src/agent-block/cache.ts');

test('buildCacheKey is stable for identical inputs', () => {
	const template = createBaseTemplate();
	const overrides = { model: 'gpt-5-mini' };
	const contextConfig = template.context;

	const key1 = buildCacheKey('Prompt', template, overrides, contextConfig);
	const key2 = buildCacheKey('Prompt', template, overrides, contextConfig);

	assert.equal(key1, key2);
});

test('buildCacheKey changes when meaningful inputs change', () => {
	const template = createBaseTemplate();
	const key1 = buildCacheKey('Prompt', template, {}, template.context);
	const key2 = buildCacheKey('Prompt', template, { model: 'different-model' }, template.context);

	assert.notEqual(key1, key2);
});

test('buildBlockCacheId changes with section or fallback hash source', () => {
	const withLineA = buildBlockCacheId('source text', 'note.md', { lineStart: 10 });
	const withLineB = buildBlockCacheId('source text', 'note.md', { lineStart: 11 });
	assert.notEqual(withLineA, withLineB);

	const noLineA = buildBlockCacheId('source text A', 'note.md', null);
	const noLineB = buildBlockCacheId('source text B', 'note.md', null);
	assert.notEqual(noLineA, noLineB);
});
