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

test('reconcileBlockCacheEntriesForSourcePath migrates history by fingerprint when ordinals shift', () => {
	const {
		reconcileBlockCacheEntriesForSourcePath,
	} = loadTs('../../src/core/prompt-cache.ts');

	const history = {
		'agent-block:note.md#0': ['hash-old'],
	};
	const index = {
		'agent-block:note.md#0': 'hash-old',
	};
	const fingerprintIndex = {
		'agent-block:note.md#0': 'fp-original',
	};

	const changed = reconcileBlockCacheEntriesForSourcePath({
		sourceBlockIds: ['agent-block:note.md#0'],
		currentBlocks: [
			{ blockId: 'agent-block:note.md#0', sourceFingerprint: 'fp-new' },
			{ blockId: 'agent-block:note.md#1', sourceFingerprint: 'fp-original' },
		],
		blockPromptCacheHistory: history,
		blockPromptCacheIndex: index,
		blockPromptCacheSourceFingerprintIndex: fingerprintIndex,
	});

	assert.equal(changed, true);
	assert.deepEqual(history, {
		'agent-block:note.md#1': ['hash-old'],
	});
	assert.deepEqual(index, {
		'agent-block:note.md#1': 'hash-old',
	});
	assert.deepEqual(fingerprintIndex, {
		'agent-block:note.md#0': 'fp-new',
		'agent-block:note.md#1': 'fp-original',
	});
});

test('reconcileBlockCacheEntriesForSourcePath falls back to ordinal when fingerprint is unavailable', () => {
	const {
		reconcileBlockCacheEntriesForSourcePath,
	} = loadTs('../../src/core/prompt-cache.ts');

	const history = {
		'agent-block:note.md#0': ['hash-0'],
		'agent-block:note.md#1': ['hash-1'],
	};
	const index = {
		'agent-block:note.md#0': 'hash-0',
		'agent-block:note.md#1': 'hash-1',
	};
	const fingerprintIndex = {};

	const changed = reconcileBlockCacheEntriesForSourcePath({
		sourceBlockIds: ['agent-block:note.md#0', 'agent-block:note.md#1'],
		currentBlocks: [
			{ blockId: 'agent-block:note.md#0', sourceFingerprint: 'fp-a' },
			{ blockId: 'agent-block:note.md#1', sourceFingerprint: 'fp-b' },
		],
		blockPromptCacheHistory: history,
		blockPromptCacheIndex: index,
		blockPromptCacheSourceFingerprintIndex: fingerprintIndex,
	});

	assert.equal(changed, true);
	assert.deepEqual(history, {
		'agent-block:note.md#0': ['hash-0'],
		'agent-block:note.md#1': ['hash-1'],
	});
	assert.deepEqual(index, {
		'agent-block:note.md#0': 'hash-0',
		'agent-block:note.md#1': 'hash-1',
	});
	assert.deepEqual(fingerprintIndex, {
		'agent-block:note.md#0': 'fp-a',
		'agent-block:note.md#1': 'fp-b',
	});
});
