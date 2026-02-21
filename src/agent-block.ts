import path from 'path';
import { createHash } from 'crypto';
import { FileSystemAdapter, MarkdownRenderChild, MarkdownRenderer, Plugin } from 'obsidian';
import type { AgentBlockOverrides, AgentInvocation, AgentOutputChunk } from './agent-types';
import type { AgentBlocksSettings, AgentTemplate } from './settings';

interface AgentBlockDependencies {
	getSettings: () => AgentBlocksSettings;
	resolveTemplate: (templateId: string | null) => AgentTemplate | null;
	runAgent: (request: {
		template: AgentTemplate;
		prompt: string;
		overrides: AgentBlockOverrides;
		onInvocation?: (invocation: AgentInvocation) => void;
		onOutputChunk?: (chunk: AgentOutputChunk) => void;
	}) => Promise<string>;
	startExecutionLog: (entry: {
		timestamp: string;
		originNote: string;
		agentTemplateId: string;
		agentTemplateName: string;
		provider: AgentTemplate['provider'];
		prompt: string;
	}) => Promise<string>;
	setExecutionLogInvocation: (id: string, invocation: AgentInvocation) => Promise<void>;
	appendExecutionLogOutput: (id: string, stream: 'stdout' | 'stderr', text: string) => Promise<void>;
	completeExecutionLog: (
		id: string,
		entry: { response: string; wasError: boolean; durationMs: number },
	) => Promise<void>;
	getCachedResponse: (cacheKey: string) => string | null;
	cacheResponse: (cacheKey: string, response: string) => Promise<void>;
}

interface ResolvedBlockRequest {
	template: AgentTemplate;
	prompt: string;
	overrides: AgentBlockOverrides;
}

interface PromptContext {
	vaultRootPath: string;
	currentFilePath: string;
	currentFileVaultPath: string;
	outgoingLinks: string[];
	backlinks: string[];
}

const TEMPLATE_REFERENCE_REGEX = /^(template|use)\s*:\s*(.+)$/iu;
const MODEL_REFERENCE_REGEX = /^model\s*:\s*(.+)$/iu;
const REASONING_REFERENCE_REGEX = /^(reasoning|reasoning_effort)\s*:\s*(.+)$/iu;
const TEMPERATURE_REFERENCE_REGEX = /^temperature\s*:\s*(.+)$/iu;
const TIMEOUT_REFERENCE_REGEX = /^(timeout|timeout_seconds|execution_timeout_seconds)\s*:\s*(.+)$/iu;
const MCP_REFERENCE_REGEX = /^(mcp|mcp_enabled)\s*:\s*(.+)$/iu;
const HOST_REFERENCE_REGEX = /^host\s*:\s*(.+)$/iu;
const KEEP_ALIVE_REFERENCE_REGEX = /^(keep_alive|keepalive)\s*:\s*(.+)$/iu;
const NUM_PREDICT_REFERENCE_REGEX = /^(num_predict|max_tokens)\s*:\s*(.+)$/iu;
const OSS_REFERENCE_REGEX = /^(oss|codex_oss)\s*:\s*(.+)$/iu;
const LOCAL_PROVIDER_REFERENCE_REGEX = /^(local_provider|codex_local_provider)\s*:\s*(.+)$/iu;

export function registerAgentCodeBlockProcessor(plugin: Plugin, dependencies: AgentBlockDependencies): void {
	plugin.registerMarkdownCodeBlockProcessor('agent', async (source, el, ctx) => {
		const blockEl = el.createDiv({ cls: 'agent-block' });
		const headerEl = blockEl.createDiv({ cls: 'agent-block__header' });
		const statusEl = headerEl.createDiv({ cls: 'agent-block__status' });
		const refreshButtonEl = headerEl.createEl('button', {
			cls: 'agent-block__refresh',
			text: '↻',
		});
		refreshButtonEl.type = 'button';
		refreshButtonEl.ariaLabel = 'Refresh agent output';
		const outputEl = blockEl.createDiv({ cls: 'agent-block__output' });
		let runSequence = 0;

		const isRunActive = (runId: number): boolean => blockEl.isConnected && runId === runSequence;

		const runExecution = async (forceRefresh: boolean): Promise<void> => {
			runSequence += 1;
			const runId = runSequence;
			const startedAt = Date.now();
			const timestamp = new Date().toISOString();
			let executionLogId: string | null = null;

			blockEl.removeClass('is-error');
			blockEl.addClass('is-loading');
			refreshButtonEl.disabled = true;

			try {
				const resolvedBlock = resolveBlockRequest(source, dependencies);
				const promptContext = buildPromptContext(plugin, ctx.sourcePath);
				const standardizedPrompt = buildStandardizedPrompt(
					resolvedBlock.prompt,
					promptContext,
					dependencies.getSettings().globalInstructions,
				);
				const cacheKey = buildCacheKey(standardizedPrompt, resolvedBlock.template, resolvedBlock.overrides);

				statusEl.setText(
					`Running ${resolvedBlock.template.name || resolvedBlock.template.id} (${resolvedBlock.template.provider})...`,
				);
				outputEl.setText(forceRefresh ? 'Refreshing response...' : 'Waiting for response...');

				if (!forceRefresh) {
					const cachedResponse = dependencies.getCachedResponse(cacheKey);
					if (cachedResponse !== null) {
						if (!isRunActive(runId)) {
							return;
						}
						blockEl.removeClass('is-loading');
						statusEl.setText('Agent result (cached)');
						await renderAgentResponse(plugin, ctx.sourcePath, outputEl, cachedResponse, ctx);
						return;
					}
				}

				executionLogId = await startExecutionLogSafely(dependencies, {
					timestamp,
					originNote: ctx.sourcePath,
					agentTemplateId: resolvedBlock.template.id,
					agentTemplateName: resolvedBlock.template.name,
					provider: resolvedBlock.template.provider,
					prompt: standardizedPrompt,
				});

				const response = await dependencies.runAgent({
					template: resolvedBlock.template,
					prompt: standardizedPrompt,
					overrides: resolvedBlock.overrides,
					onInvocation: (invocation) => {
						if (!executionLogId) {
							return;
						}
						void setExecutionLogInvocationSafely(dependencies, executionLogId, invocation);
					},
					onOutputChunk: (chunk) => {
						if (!executionLogId) {
							return;
						}
						void appendExecutionLogOutputSafely(dependencies, executionLogId, chunk.stream, chunk.text);
					},
				});

				await cacheResponseSafely(dependencies, cacheKey, response);
				if (executionLogId) {
					await completeExecutionLogSafely(dependencies, executionLogId, {
						response,
						wasError: false,
						durationMs: Date.now() - startedAt,
					});
				}

				if (!isRunActive(runId)) {
					return;
				}

				const durationMs = Date.now() - startedAt;
				blockEl.removeClass('is-loading');
				statusEl.setText(`Agent result generated in ${formatBlockDuration(durationMs)}`);
				await renderAgentResponse(plugin, ctx.sourcePath, outputEl, response, ctx);
			} catch (error: unknown) {
				if (executionLogId) {
					await completeExecutionLogSafely(dependencies, executionLogId, {
						response: getErrorMessage(error),
						wasError: true,
						durationMs: Date.now() - startedAt,
					});
				}

				if (!isRunActive(runId)) {
					return;
				}

				blockEl.removeClass('is-loading');
				blockEl.addClass('is-error');
				statusEl.setText('Agent execution failed');
				outputEl.empty();
				outputEl.createEl('pre', {
					cls: 'agent-block__error',
					text: getErrorMessage(error),
				});
			} finally {
				if (isRunActive(runId)) {
					refreshButtonEl.disabled = false;
				}
			}
		};

		refreshButtonEl.addEventListener('click', () => {
			void runExecution(true);
		});

		void runExecution(false);
	});
}

function resolveBlockRequest(source: string, dependencies: AgentBlockDependencies): ResolvedBlockRequest {
	if (!source.trim()) {
		throw new Error('The agent block is empty. Add instructions or reference a template.');
	}

	const lines = source.split(/\r?\n/u);
	const directives = extractBlockDirectives(lines);
	const instructionBody = lines.slice(directives.instructionsStartIndex).join('\n').trim();
	const template = dependencies.resolveTemplate(directives.templateId);

	if (!template) {
		if (directives.templateId) {
			throw new Error(`No agent template found for ID "${directives.templateId}".`);
		}
		throw new Error('No agent templates are configured. Create one in plugin settings.');
	}

	const instructionParts = [template.instructions.trim(), instructionBody].filter((part) => part.length > 0);
	if (instructionParts.length === 0) {
		throw new Error('No instruction was provided. Add instructions in the block or template.');
	}

	return {
		template,
		prompt: instructionParts.join('\n\n'),
		overrides: directives.overrides,
	};
}

function extractBlockDirectives(lines: string[]): {
	templateId: string | null;
	overrides: AgentBlockOverrides;
	instructionsStartIndex: number;
} {
	let index = 0;
	while (index < lines.length && (lines[index]?.trim().length ?? 0) === 0) {
		index += 1;
	}

	let templateId: string | null = null;
	const overrides: AgentBlockOverrides = {};

	while (index < lines.length) {
		const line = lines[index] ?? '';
		const trimmed = line.trim();
		if (!trimmed) {
			index += 1;
			continue;
		}

		const templateMatch = TEMPLATE_REFERENCE_REGEX.exec(trimmed);
		if (templateMatch) {
			const parsedTemplateId = (templateMatch[2] ?? '').trim();
			if (!parsedTemplateId) {
				throw new Error('Template directive is missing a value. Use: template: your-template-id');
			}
			templateId = parsedTemplateId;
			index += 1;
			continue;
		}

		const modelMatch = MODEL_REFERENCE_REGEX.exec(trimmed);
		if (modelMatch) {
			overrides.model = requireNonEmptyValue(modelMatch[1], 'Model override is missing a value. Use: model: gpt-5-mini');
			index += 1;
			continue;
		}

		const reasoningMatch = REASONING_REFERENCE_REGEX.exec(trimmed);
		if (reasoningMatch) {
			overrides.reasoningEffort = requireNonEmptyValue(
				reasoningMatch[2],
				'Reasoning override is missing a value. Use: reasoning: low',
			);
			index += 1;
			continue;
		}

		const temperatureMatch = TEMPERATURE_REFERENCE_REGEX.exec(trimmed);
		if (temperatureMatch) {
			overrides.temperature = parseNumberDirective(
				temperatureMatch[1],
				'Temperature override must be a number. Use: temperature: 0.2',
			);
			index += 1;
			continue;
		}

		const timeoutMatch = TIMEOUT_REFERENCE_REGEX.exec(trimmed);
		if (timeoutMatch) {
			overrides.executionTimeoutSeconds = parseIntegerDirective(
				timeoutMatch[2],
				'Timeout override must be an integer. Use: timeout: 120',
			);
			index += 1;
			continue;
		}

		const mcpMatch = MCP_REFERENCE_REGEX.exec(trimmed);
		if (mcpMatch) {
			overrides.mcpEnabled = parseBooleanDirective(
				mcpMatch[2],
				'MCP override must be true or false. Use: mcp: false',
			);
			index += 1;
			continue;
		}

		const hostMatch = HOST_REFERENCE_REGEX.exec(trimmed);
		if (hostMatch) {
			overrides.host = requireNonEmptyValue(hostMatch[1], 'Host override is missing a value. Use: host: http://127.0.0.1:11434');
			index += 1;
			continue;
		}

		const keepAliveMatch = KEEP_ALIVE_REFERENCE_REGEX.exec(trimmed);
		if (keepAliveMatch) {
			overrides.keepAlive = requireNonEmptyValue(keepAliveMatch[2], 'Keep alive override is missing a value. Use: keep_alive: 5m');
			index += 1;
			continue;
		}

		const numPredictMatch = NUM_PREDICT_REFERENCE_REGEX.exec(trimmed);
		if (numPredictMatch) {
			overrides.numPredict = parseIntegerDirective(
				numPredictMatch[2],
				'num_predict override must be an integer. Use: num_predict: 512',
			);
			index += 1;
			continue;
		}

		const ossMatch = OSS_REFERENCE_REGEX.exec(trimmed);
		if (ossMatch) {
			overrides.useOssModelProvider = parseBooleanDirective(
				ossMatch[2],
				'OSS override must be true or false. Use: oss: true',
			);
			index += 1;
			continue;
		}

		const localProviderMatch = LOCAL_PROVIDER_REFERENCE_REGEX.exec(trimmed);
		if (localProviderMatch) {
			overrides.localProvider = requireNonEmptyValue(
				localProviderMatch[2],
				'Local provider override is missing a value. Use: local_provider: ollama',
			);
			index += 1;
			continue;
		}

		break;
	}

	return {
		templateId,
		overrides,
		instructionsStartIndex: index,
	};
}

function requireNonEmptyValue(value: string | undefined, message: string): string {
	const normalized = (value ?? '').trim();
	if (!normalized) {
		throw new Error(message);
	}
	return normalized;
}

function parseNumberDirective(value: string | undefined, message: string): number {
	const parsed = Number.parseFloat((value ?? '').trim());
	if (!Number.isFinite(parsed)) {
		throw new Error(message);
	}
	return parsed;
}

function parseIntegerDirective(value: string | undefined, message: string): number {
	const parsed = Number.parseInt((value ?? '').trim(), 10);
	if (!Number.isFinite(parsed)) {
		throw new Error(message);
	}
	return parsed;
}

function parseBooleanDirective(value: string | undefined, message: string): boolean {
	const normalized = (value ?? '').trim().toLowerCase();
	if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
		return true;
	}
	if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
		return false;
	}
	throw new Error(message);
}

function buildCacheKey(prompt: string, template: AgentTemplate, overrides: AgentBlockOverrides): string {
	const payload = JSON.stringify({
		prompt,
		templateId: template.id,
		provider: template.provider,
		templateConfig: template.providerConfig,
		overrides: {
			model: overrides.model ?? null,
			reasoningEffort: overrides.reasoningEffort ?? null,
			useOssModelProvider: overrides.useOssModelProvider ?? null,
			localProvider: overrides.localProvider ?? null,
			temperature: overrides.temperature ?? null,
			executionTimeoutSeconds: overrides.executionTimeoutSeconds ?? null,
			mcpEnabled: overrides.mcpEnabled ?? null,
			host: overrides.host ?? null,
			keepAlive: overrides.keepAlive ?? null,
			numPredict: overrides.numPredict ?? null,
		},
	});
	return createHash('sha256').update(payload).digest('hex');
}

async function renderAgentResponse(
	plugin: Plugin,
	sourcePath: string,
	outputEl: HTMLElement,
	response: string,
	ctx: { addChild: (child: MarkdownRenderChild) => void },
): Promise<void> {
	outputEl.empty();
	if (!response.trim()) {
		outputEl.createEl('p', { text: 'Agent returned an empty response.' });
		return;
	}

	const renderChild = new MarkdownRenderChild(outputEl);
	ctx.addChild(renderChild);
	await MarkdownRenderer.render(plugin.app, response, outputEl, sourcePath, renderChild);
}

function buildPromptContext(plugin: Plugin, sourcePath: string): PromptContext {
	const vaultRootPath = getVaultRootPath(plugin);
	return {
		vaultRootPath,
		currentFilePath: getAbsoluteFilePath(vaultRootPath, sourcePath),
		currentFileVaultPath: sourcePath || '(current file path unavailable)',
		outgoingLinks: getOutgoingLinks(plugin, sourcePath),
		backlinks: getBacklinks(plugin, sourcePath),
	};
}

function getVaultRootPath(plugin: Plugin): string {
	const adapter = plugin.app.vault.adapter;
	if (adapter instanceof FileSystemAdapter) {
		return adapter.getBasePath();
	}
	return '(vault root path unavailable)';
}

function getAbsoluteFilePath(vaultRootPath: string, sourcePath: string): string {
	if (!sourcePath) {
		return '(current file path unavailable)';
	}
	if (vaultRootPath.startsWith('(')) {
		return sourcePath;
	}
	const normalizedSourcePath = sourcePath.split('/').join(path.sep);
	return path.join(vaultRootPath, normalizedSourcePath);
}

function getOutgoingLinks(plugin: Plugin, sourcePath: string): string[] {
	const resolved = plugin.app.metadataCache.resolvedLinks[sourcePath] ?? {};
	const unresolved = plugin.app.metadataCache.unresolvedLinks[sourcePath] ?? {};

	const links = new Set<string>();
	for (const targetPath of Object.keys(resolved)) {
		links.add(targetPath);
	}
	for (const unresolvedTarget of Object.keys(unresolved)) {
		links.add(`${unresolvedTarget} (unresolved)`);
	}

	return [...links].sort((a, b) => a.localeCompare(b));
}

function getBacklinks(plugin: Plugin, sourcePath: string): string[] {
	if (!sourcePath) {
		return [];
	}

	const backlinks = new Set<string>();
	for (const [candidateSource, targets] of Object.entries(plugin.app.metadataCache.resolvedLinks)) {
		if ((targets[sourcePath] ?? 0) > 0) {
			backlinks.add(candidateSource);
		}
	}
	return [...backlinks].sort((a, b) => a.localeCompare(b));
}

function buildStandardizedPrompt(
	userInstruction: string,
	context: PromptContext,
	globalInstructions: string,
): string {
	const trimmedGlobalInstructions = globalInstructions.trim();

	return [
		'You are an agent running inside an Obsidian plugin block.',
		'Use the context below to fulfill the instruction exactly.',
		'Start the response with a concise Markdown H4 title derived from the instruction.',
		'Use Obsidian-flavored Markdown where useful (wikilinks, headings, lists, callouts, tables).',
		'When summarizing, preserve and include relevant Obsidian note links, especially existing [[Note Links]].',
		'For vault-internal links, use only Obsidian wikilinks like [[Note]], [[Folder/Note]], or [[Note#Heading]].',
		'Do not use standard Markdown links for vault files or relative paths (for example [X](folder/note.md)).',
		'Use standard Markdown links only for external web URLs with http or https.',
		'Respond concisely with only the final output requested by the instruction.',
		'Do not include any reasoning, hidden thoughts, tool usage, skill usage, skill selection, or process commentary.',
		'Never mention skills, capabilities, or internal workflow details in the output.',
		'If completion is blocked, return only a short issue message.',
		'',
		'Context:',
		`- Vault root path: ${context.vaultRootPath}`,
		`- Current file path: ${context.currentFilePath}`,
		`- Current file vault path: ${context.currentFileVaultPath}`,
		'- Outgoing links:',
		formatLinkList(context.outgoingLinks),
		'- Backlinks:',
		formatLinkList(context.backlinks),
		'',
		...(trimmedGlobalInstructions
			? [
				'Global instructions:',
				'<global_instructions>',
				trimmedGlobalInstructions,
				'</global_instructions>',
				'',
			]
			: []),
		'User instruction:',
		'<instruction>',
		userInstruction.trim(),
		'</instruction>',
	].join('\n');
}

function formatLinkList(links: string[]): string {
	if (links.length === 0) {
		return '- None';
	}
	return links.map((link) => `- ${link}`).join('\n');
}

function formatBlockDuration(durationMs: number): string {
	if (durationMs < 1000) {
		return `${durationMs}ms`;
	}
	return `${(durationMs / 1000).toFixed(2)}s`;
}

async function startExecutionLogSafely(
	dependencies: AgentBlockDependencies,
	entry: {
		timestamp: string;
		originNote: string;
		agentTemplateId: string;
		agentTemplateName: string;
		provider: AgentTemplate['provider'];
		prompt: string;
	},
): Promise<string | null> {
	try {
		return await dependencies.startExecutionLog(entry);
	} catch {
		return null;
	}
}

async function setExecutionLogInvocationSafely(
	dependencies: AgentBlockDependencies,
	id: string,
	invocation: AgentInvocation,
): Promise<void> {
	try {
		await dependencies.setExecutionLogInvocation(id, invocation);
	} catch {
		// Logging should not break block rendering.
	}
}

async function appendExecutionLogOutputSafely(
	dependencies: AgentBlockDependencies,
	id: string,
	stream: 'stdout' | 'stderr',
	text: string,
): Promise<void> {
	try {
		await dependencies.appendExecutionLogOutput(id, stream, text);
	} catch {
		// Logging should not break block rendering.
	}
}

async function completeExecutionLogSafely(
	dependencies: AgentBlockDependencies,
	id: string,
	entry: { response: string; wasError: boolean; durationMs: number },
): Promise<void> {
	try {
		await dependencies.completeExecutionLog(id, entry);
	} catch {
		// Logging should not break block rendering.
	}
}

async function cacheResponseSafely(
	dependencies: AgentBlockDependencies,
	cacheKey: string,
	response: string,
): Promise<void> {
	try {
		await dependencies.cacheResponse(cacheKey, response);
	} catch {
		// Cache writes should not break block rendering.
	}
}

function getErrorMessage(error: unknown): string {
	if (error instanceof Error && error.message) {
		return error.message;
	}
	return 'Unknown error while running agent execution.';
}
