import type { AgentBlockOverrides, AgentInvocation, AgentOutputChunk } from '../agent-types';
import type { OllamaAgentProviderConfig } from '../settings';
import { requestUrl } from 'obsidian';
import type { AgentProvider, AgentRunRequest, AgentRunResult } from './types';

export class OllamaProvider implements AgentProvider {
	async run(request: AgentRunRequest): Promise<AgentRunResult> {
		if (request.template.provider !== 'ollama') {
			throw new Error('Ollama provider received a non-ollama template.');
		}

		const promptText = request.prompt.trim();
		if (!promptText) {
			throw new Error('Prompt is empty. Add content to the agent block or template.');
		}

		const effectiveConfig = resolveOllamaConfig(request.template.providerConfig, request.overrides);

		safelyEmitInvocation(request.onInvocation, {
			command: 'ollama.http',
			args: [
				`host=${effectiveConfig.host}`,
				`model=${effectiveConfig.model}`,
				`temperature=${String(effectiveConfig.temperature)}`,
				`num_predict=${String(effectiveConfig.numPredict)}`,
				`keep_alive=${effectiveConfig.keepAlive}`,
			],
		});

		const baseRequest: Record<string, unknown> = {
			model: effectiveConfig.model,
			messages: [{ role: 'user', content: promptText }],
			options: {
				temperature: effectiveConfig.temperature,
				num_predict: effectiveConfig.numPredict,
			},
			keep_alive: effectiveConfig.keepAlive,
			keepAlive: effectiveConfig.keepAlive,
		};

		const streamedResponse = await runOllamaChat(
			effectiveConfig.host,
			baseRequest,
			request.onOutputChunk,
			request.abortSignal,
		);
		return { response: streamedResponse.trim() };
	}

	dispose(): void {
		// No persistent resources to release for the Ollama client.
	}
}

function resolveOllamaConfig(
	config: OllamaAgentProviderConfig,
	overrides: AgentBlockOverrides,
): OllamaAgentProviderConfig {
	return {
		host: normalizeHost(normalizeString(overrides.host) ?? config.host),
		model: normalizeString(overrides.model) ?? config.model,
		temperature: typeof overrides.temperature === 'number'
			? normalizeTemperature(overrides.temperature)
			: normalizeTemperature(config.temperature),
		numPredict: typeof overrides.numPredict === 'number'
			? normalizeNumPredict(overrides.numPredict)
			: normalizeNumPredict(config.numPredict),
		keepAlive: normalizeString(overrides.keepAlive) ?? config.keepAlive,
	};
}

function normalizeHost(host: string): string {
	const trimmed = host.trim().replace(/\/+$/u, '');
	return trimmed.length > 0 ? trimmed : 'http://127.0.0.1:11434';
}

function normalizeString(value: string | null | undefined): string | null {
	if (!value) {
		return null;
	}
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : null;
}

function normalizeTemperature(value: number): number {
	if (!Number.isFinite(value)) {
		return 0.2;
	}
	if (value < 0) {
		return 0;
	}
	if (value > 2) {
		return 2;
	}
	return Number(value.toFixed(2));
}

function normalizeNumPredict(value: number): number {
	if (!Number.isFinite(value)) {
		return 512;
	}
	if (value < 1) {
		return 1;
	}
	if (value > 32768) {
		return 32768;
	}
	return Math.round(value);
}

async function runOllamaChat(
	host: string,
	baseRequest: Record<string, unknown>,
	onOutputChunk?: (chunk: AgentOutputChunk) => void,
	abortSignal?: AbortSignal,
): Promise<string> {
	ensureNotCancelled(abortSignal);

	const streamRequest: Record<string, unknown> = {
		...baseRequest,
		stream: true,
	};

	const streamResponse = await requestUrl({
		url: `${host}/api/chat`,
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(streamRequest),
	});
	if (streamResponse.status >= 400) {
		throw new Error(`Ollama request failed (${streamResponse.status}): ${streamResponse.text || 'Unknown error'}`);
	}
	ensureNotCancelled(abortSignal);

	let finalResponse = '';
	const streamLines = (streamResponse.text || '').split('\n');
	for (const line of streamLines) {
		ensureNotCancelled(abortSignal);
		const trimmed = line.trim();
		if (!trimmed) {
			continue;
		}
		const parsed = parseJsonLine(trimmed);
		const chunkText = extractOllamaChunkText(parsed);
		if (!chunkText) {
			continue;
		}
		finalResponse += chunkText;
		safelyEmitOutputChunk(onOutputChunk, {
			stream: 'stdout',
			text: chunkText,
		});
	}

	if (finalResponse.trim()) {
		return finalResponse;
	}

	ensureNotCancelled(abortSignal);
	const nonStreamResponse = await requestUrl({
		url: `${host}/api/chat`,
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
		...baseRequest,
		stream: false,
		}),
	});
	if (nonStreamResponse.status >= 400) {
		throw new Error(`Ollama request failed (${nonStreamResponse.status}): ${nonStreamResponse.text || 'Unknown error'}`);
	}
	ensureNotCancelled(abortSignal);
	const nonStreamResult = parseJsonLine(nonStreamResponse.text || '');
	const nonStreamText = extractOllamaChunkText(nonStreamResult);
	if (nonStreamText) {
		safelyEmitOutputChunk(onOutputChunk, { stream: 'stdout', text: nonStreamText });
		return nonStreamText;
	}
	return '';
}

function ensureNotCancelled(abortSignal?: AbortSignal): void {
	if (abortSignal?.aborted) {
		throw new Error('Agent execution canceled by user.');
	}
}

function extractOllamaChunkText(part: unknown): string {
	if (!part || typeof part !== 'object') {
		return '';
	}

	const candidate = part as {
		message?: { content?: unknown };
		response?: unknown;
	};

	if (typeof candidate.message?.content === 'string') {
		return candidate.message.content;
	}
	if (typeof candidate.response === 'string') {
		return candidate.response;
	}
	return '';
}

function parseJsonLine(line: string): unknown {
	try {
		return JSON.parse(line) as unknown;
	} catch {
		return {};
	}
}

function safelyEmitOutputChunk(
	onOutputChunk: ((chunk: AgentOutputChunk) => void) | undefined,
	chunk: AgentOutputChunk,
): void {
	if (!onOutputChunk || !chunk.text) {
		return;
	}
	try {
		onOutputChunk(chunk);
	} catch {
		// Stream logging must not break execution.
	}
}

function safelyEmitInvocation(
	onInvocation: ((invocation: AgentInvocation) => void) | undefined,
	invocation: AgentInvocation,
): void {
	if (!onInvocation) {
		return;
	}
	try {
		onInvocation(invocation);
	} catch {
		// Invocation logging must not break execution.
	}
}
