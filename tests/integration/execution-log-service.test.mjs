import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from '../helpers/load-ts.mjs';
import { createExecutionLogEntry, createSettings } from '../helpers/fixtures.mjs';

const { ExecutionLogService } = loadTs('../../src/core/execution-log-service.ts');

function createHarness(initialSettings = createSettings()) {
	const settings = initialSettings;
	let saveCount = 0;
	let notifyCount = 0;
	const deletedCancellationIds = [];
	const prunedRetainedSets = [];

	const service = new ExecutionLogService({
		getSettings: () => settings,
		saveSettings: async () => {
			saveCount += 1;
		},
		notifyExecutionLogUpdated: () => {
			notifyCount += 1;
		},
		deleteCancellationByLogId: (id) => {
			deletedCancellationIds.push(id);
		},
		pruneCancellationRegistry: (retainedIds) => {
			prunedRetainedSets.push(retainedIds);
		},
	});

	return {
		service,
		settings,
		get saveCount() { return saveCount; },
		get notifyCount() { return notifyCount; },
		deletedCancellationIds,
		prunedRetainedSets,
	};
}

test('ExecutionLogService.start adds a running entry and notifies', async () => {
	const harness = createHarness();

	const id = await harness.service.start({
		timestamp: '2024-01-01T00:00:00.000Z',
		originNote: 'note.md',
		agentTemplateId: 'template-1',
		agentTemplateName: 'Template 1',
		provider: 'codex',
		prompt: 'Prompt',
	});

	assert.equal(harness.settings.executionLog.length, 1);
	assert.equal(harness.settings.executionLog[0].id, id);
	assert.equal(harness.settings.executionLog[0].status, 'running');
	assert.equal(harness.saveCount, 1);
	assert.equal(harness.notifyCount, 1);
});

test('ExecutionLogService.appendOutput throttles save frequency', async () => {
	const harness = createHarness();
	const id = await harness.service.start({
		timestamp: '2024-01-01T00:00:00.000Z',
		originNote: 'note.md',
		agentTemplateId: 'template-1',
		agentTemplateName: 'Template 1',
		provider: 'codex',
		prompt: 'Prompt',
	});

	const startSaveCount = harness.saveCount;
	await harness.service.appendOutput(id, 'stdout', 'hello');
	await harness.service.appendOutput(id, 'stdout', ' world');

	assert.equal(harness.saveCount - startSaveCount, 1);
	assert.equal(harness.settings.executionLog[0].processOutput.includes('[stdout]\nhello world'), true);
});

test('ExecutionLogService.complete finalizes entry and clears cancellation mapping', async () => {
	const harness = createHarness();
	const id = await harness.service.start({
		timestamp: '2024-01-01T00:00:00.000Z',
		originNote: 'note.md',
		agentTemplateId: 'template-1',
		agentTemplateName: 'Template 1',
		provider: 'codex',
		prompt: 'Prompt',
	});

	await harness.service.complete(id, {
		response: 'Done',
		wasError: false,
		durationMs: 250,
	});

	assert.equal(harness.settings.executionLog[0].status, 'success');
	assert.equal(harness.settings.executionLog[0].response, 'Done');
	assert.equal(harness.deletedCancellationIds.includes(id), true);
});

test('ExecutionLogService.start prunes to max log entries and notifies cancellation registry', async () => {
	const existingEntries = Array.from({ length: 100 }, (_, i) => createExecutionLogEntry(`existing-${i}`));
	const harness = createHarness(createSettings({ executionLog: existingEntries }));

	await harness.service.start({
		timestamp: '2024-01-01T00:00:00.000Z',
		originNote: 'note.md',
		agentTemplateId: 'template-1',
		agentTemplateName: 'Template 1',
		provider: 'codex',
		prompt: 'Prompt',
	});

	assert.equal(harness.settings.executionLog.length, 100);
	assert.equal(harness.prunedRetainedSets.length, 1);
	assert.equal(harness.prunedRetainedSets[0].size, 100);
});
