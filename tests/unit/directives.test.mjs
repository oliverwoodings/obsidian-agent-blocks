import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from '../helpers/load-ts.mjs';
import { createBaseTemplate } from '../helpers/fixtures.mjs';

const { resolveBlockRequest } = loadTs('../../src/agent-block/directives.ts');

function createDependencies(template = createBaseTemplate()) {
	return {
		resolveTemplate: (id) => {
			if (!id || id === template.id) {
				return template;
			}
			return null;
		},
	};
}

test('resolveBlockRequest parses template, overrides, and instruction body', () => {
	const source = [
		'template: template-1',
		'model: gpt-5-mini',
		'reasoning: low',
		'temperature: 0.2',
		'timeout: 120',
		'mcp: false',
		'cache_mode: manual-refresh',
		'linked_content: true',
		'linked_content_max_notes: 7',
		'linked_content_sort_by: created-date',
		'',
		'Summarize this note.',
	].join('\n');

	const resolved = resolveBlockRequest(source, createDependencies());

	assert.equal(resolved.template.id, 'template-1');
	assert.equal(resolved.prompt.includes('Base instructions'), true);
	assert.equal(resolved.prompt.includes('Summarize this note.'), true);
	assert.equal(resolved.overrides.model, 'gpt-5-mini');
	assert.equal(resolved.overrides.reasoningEffort, 'low');
	assert.equal(resolved.overrides.temperature, 0.2);
	assert.equal(resolved.overrides.executionTimeoutSeconds, 120);
	assert.equal(resolved.overrides.mcpEnabled, false);
	assert.equal(resolved.cacheMode, 'prefer-cache');
	assert.equal(resolved.contextConfig.linkedNoteContent.enabled, true);
	assert.equal(resolved.contextConfig.linkedNoteContent.maxNotes, 7);
	assert.equal(resolved.contextConfig.linkedNoteContent.sort.field, 'created-date');
});

test('resolveBlockRequest fails for unknown template', () => {
	assert.throws(
		() => resolveBlockRequest('template: missing\nDo thing', createDependencies()),
		/No agent template found for ID "missing"/,
	);
});

test('resolveBlockRequest fails for invalid boolean directive', () => {
	assert.throws(
		() => resolveBlockRequest('mcp: maybe\nDo thing', createDependencies()),
		/MCP override must be true or false/,
	);
});

test('resolveBlockRequest treats first non-directive line as instruction', () => {
	const source = 'This line is not a directive\nmodel: should-not-parse';
	const resolved = resolveBlockRequest(source, createDependencies());

	assert.equal(resolved.overrides.model, undefined);
	assert.equal(resolved.prompt.includes('This line is not a directive'), true);
	assert.equal(resolved.prompt.includes('model: should-not-parse'), true);
});
