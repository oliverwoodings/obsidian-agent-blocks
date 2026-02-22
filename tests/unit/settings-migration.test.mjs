import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from '../helpers/load-ts.mjs';
import { createBaseTemplate } from '../helpers/fixtures.mjs';

const { migrateAndNormalizeSettings } = loadTs('../../src/core/settings-migration.ts');

test('migrateAndNormalizeSettings returns defaults for null input', () => {
	const settings = migrateAndNormalizeSettings(null);

	assert.equal(settings.agentTemplates.length, 1);
	assert.equal(settings.defaultAgentTemplateId, 'default-agent');
	assert.equal(settings.promptCacheMaxEntries, 1000);
	assert.deepEqual(settings.promptCache, {});
});

test('migrateAndNormalizeSettings migrates legacy prompt templates and codex config', () => {
	const settings = migrateAndNormalizeSettings({
		promptTemplates: [{ id: 'legacy-1', name: 'Legacy One', prompt: 'Legacy instructions' }],
		codexCommand: '/custom/codex',
		codexArguments: 'exec\n-',
		defaultModel: 'gpt-5-mini',
		enableMcpServers: false,
	});

	assert.equal(settings.agentTemplates.length, 1);
	assert.equal(settings.agentTemplates[0].id, 'legacy-1');
	assert.equal(settings.agentTemplates[0].instructions, 'Legacy instructions');
	assert.equal(settings.agentTemplates[0].provider, 'codex');
	assert.equal(settings.agentTemplates[0].providerConfig.command, '/custom/codex');
	assert.equal(settings.agentTemplates[0].providerConfig.model, 'gpt-5-mini');
	assert.equal(settings.agentTemplates[0].providerConfig.enableMcpServers, false);
});

test('migrateAndNormalizeSettings normalizes stale running log entries and prunes cache index', () => {
	const template = createBaseTemplate();
	const settings = migrateAndNormalizeSettings({
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
	assert.equal(settings.executionLog[0].wasError, false);
	assert.deepEqual(settings.blockPromptCacheIndex, { A: 'keep' });
});
