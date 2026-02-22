import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from '../helpers/load-ts.mjs';
import { createBaseTemplate } from '../helpers/fixtures.mjs';

const { normalizeLoadedSettings } = loadTs('../../src/core/settings-normalization.ts');

test('normalizeLoadedSettings returns defaults for null input', () => {
	const settings = normalizeLoadedSettings(null);

	assert.equal(settings.agentTemplates.length, 1);
	assert.equal(settings.defaultAgentTemplateId, 'default-agent');
	assert.equal(settings.promptCacheMaxEntries, 1000);
	assert.deepEqual(settings.promptCache, {});
});

test('normalizeLoadedSettings ignores legacy-only fields when current schema is missing', () => {
	const settings = normalizeLoadedSettings({
		promptTemplates: [{ id: 'legacy-1', name: 'Legacy One', prompt: 'Legacy instructions' }],
		codexCommand: '/custom/codex',
	});

	assert.equal(settings.agentTemplates.length, 1);
	assert.equal(settings.agentTemplates[0].id, 'default-agent');
	assert.equal(settings.agentTemplates[0].provider, 'codex');
	assert.equal(settings.agentTemplates[0].providerConfig.command, 'codex');
});

test('normalizeLoadedSettings normalizes stale running log entries and prunes cache index', () => {
	const template = createBaseTemplate();
	const settings = normalizeLoadedSettings({
		agentTemplates: [template],
		defaultAgentTemplateId: template.id,
		executionLog: [{
			id: 'run-1',
			timestamp: '2024-01-01T00:00:00.000Z',
			originNote: 'note.md',
			agentTemplateId: template.id,
			agentTemplateName: template.name,
			provider: 'codex',
			prompt: 'Prompt',
			command: 'codex',
			commandArgs: [],
			response: '',
			processOutput: '',
			wasError: false,
			durationMs: Number.NaN,
			status: 'running',
		}],
		promptCache: {
			keep: { response: 'cached', cachedAt: '2024-01-01T00:00:00.000Z' },
		},
		blockPromptCacheIndex: {
			A: 'keep',
			B: 'missing',
		},
	});

	assert.equal(settings.executionLog[0].status, 'error');
	assert.equal(settings.executionLog[0].wasError, true);
	assert.deepEqual(settings.blockPromptCacheIndex, { A: 'keep' });
});
