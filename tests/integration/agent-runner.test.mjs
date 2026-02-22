import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from '../helpers/load-ts.mjs';
import { createBaseTemplate } from '../helpers/fixtures.mjs';

const { AgentRunner } = loadTs('../../src/core/agent-runner.ts');

function createOllamaTemplate() {
	return {
		id: 'template-ollama',
		name: 'Ollama template',
		provider: 'ollama',
		instructions: '',
		cacheMode: 'auto-refresh',
		context: createBaseTemplate().context,
		providerConfig: {
			host: 'http://127.0.0.1:11434',
			model: 'llama3.2',
			temperature: 0.2,
			numPredict: 512,
			keepAlive: '5m',
		},
	};
}

test('AgentRunner routes requests to matching provider', async () => {
	let codexCalls = 0;
	let ollamaCalls = 0;

	const runner = new AgentRunner(
		{
			run: async () => {
				codexCalls += 1;
				return { response: 'codex-response' };
			},
			dispose: () => {},
		},
		{
			run: async () => {
				ollamaCalls += 1;
				return { response: 'ollama-response' };
			},
			dispose: () => {},
		},
	);

	const codexResult = await runner.run({
		template: createBaseTemplate(),
		prompt: 'Prompt',
		overrides: {},
	});
	const ollamaResult = await runner.run({
		template: createOllamaTemplate(),
		prompt: 'Prompt',
		overrides: {},
	});

	assert.equal(codexResult, 'codex-response');
	assert.equal(ollamaResult, 'ollama-response');
	assert.equal(codexCalls, 1);
	assert.equal(ollamaCalls, 1);
});

test('AgentRunner supports cancellation by execution log id', async () => {
	let abortObserved = false;
	const unresolvedRun = ({ abortSignal }) => new Promise(() => {
		abortSignal?.addEventListener('abort', () => {
			abortObserved = true;
		});
	});

	const runner = new AgentRunner(
		{ run: unresolvedRun, dispose: () => {} },
		{ run: async () => ({ response: 'unused' }), dispose: () => {} },
	);

	const runPromise = runner.run({
		template: createBaseTemplate(),
		prompt: 'Prompt',
		overrides: {},
		executionLogId: 'run-1',
	});

	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(runner.cancel('run-1'), true);
	await assert.rejects(runPromise, /Agent execution canceled by user\./);
	assert.equal(abortObserved, true);
	assert.equal(runner.cancel('run-1'), false);
});

test('AgentRunner dispose cancels running executions and disposes providers', async () => {
	let codexDisposed = false;
	let ollamaDisposed = false;

	const unresolvedRun = () => new Promise(() => {});

	const runner = new AgentRunner(
		{ run: unresolvedRun, dispose: () => { codexDisposed = true; } },
		{ run: async () => ({ response: 'unused' }), dispose: () => { ollamaDisposed = true; } },
	);

	const runPromise = runner.run({
		template: createBaseTemplate(),
		prompt: 'Prompt',
		overrides: {},
		executionLogId: 'run-2',
	});

	runner.dispose();
	await assert.rejects(runPromise, /Agent execution canceled by user\./);
	assert.equal(codexDisposed, true);
	assert.equal(ollamaDisposed, true);
	assert.equal(runner.cancel('run-2'), false);
});
