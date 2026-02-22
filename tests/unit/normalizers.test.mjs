import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from '../helpers/load-ts.mjs';

const {
	normalizeTimeoutSeconds,
	normalizeTemperature,
	normalizeNumPredict,
	normalizeLinkedSortField,
	normalizePromptCacheMaxEntries,
} = loadTs('../../src/domain/normalizers.ts');

test('normalizeTimeoutSeconds clamps and falls back', () => {
	assert.equal(normalizeTimeoutSeconds('10'), 15);
	assert.equal(normalizeTimeoutSeconds(7200), 3600);
	assert.equal(normalizeTimeoutSeconds('not-a-number', 123), 123);
});

test('normalizeTemperature clamps and rounds', () => {
	assert.equal(normalizeTemperature(-1), 0);
	assert.equal(normalizeTemperature(3), 2);
	assert.equal(normalizeTemperature(0.257), 0.26);
});

test('normalizeNumPredict clamps and rounds', () => {
	assert.equal(normalizeNumPredict(0), 1);
	assert.equal(normalizeNumPredict(40000), 32768);
	assert.equal(normalizeNumPredict(512.4), 512);
});

test('normalizeLinkedSortField accepts aliases', () => {
	assert.equal(normalizeLinkedSortField('recently-created'), 'created-date');
	assert.equal(normalizeLinkedSortField('recently-modified'), 'modified-date');
	assert.equal(normalizeLinkedSortField('frontmatter-date'), 'frontmatter-date');
	assert.equal(normalizeLinkedSortField('unknown', 'created-date'), 'created-date');
});

test('normalizePromptCacheMaxEntries clamps and falls back', () => {
	assert.equal(normalizePromptCacheMaxEntries(0), 1);
	assert.equal(normalizePromptCacheMaxEntries(100_000), 50_000);
	assert.equal(normalizePromptCacheMaxEntries('bad', 250), 250);
});
