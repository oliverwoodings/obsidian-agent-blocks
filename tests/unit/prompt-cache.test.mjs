import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from '../helpers/load-ts.mjs';

const { enforcePromptCacheLimit, pruneBlockPromptCacheIndex } = loadTs('../../src/core/prompt-cache.ts');

test('enforcePromptCacheLimit keeps newest entries', () => {
	const cache = {
		a: { response: 'A', cachedAt: '2024-01-01T00:00:00.000Z' },
		b: { response: 'B', cachedAt: '2024-01-03T00:00:00.000Z' },
		c: { response: 'C', cachedAt: '2024-01-02T00:00:00.000Z' },
	};

	enforcePromptCacheLimit(cache, 2);

	assert.deepEqual(Object.keys(cache).sort(), ['b', 'c']);
});

test('pruneBlockPromptCacheIndex removes missing cache hashes', () => {
	const cache = {
		keep: { response: 'ok', cachedAt: '2024-01-01T00:00:00.000Z' },
	};
	const index = {
		blockA: 'keep',
		blockB: 'missing',
	};

	pruneBlockPromptCacheIndex(index, cache);

	assert.deepEqual(index, { blockA: 'keep' });
});
