import path from 'path';
import { createHash } from 'crypto';
import { FileSystemAdapter, MarkdownRenderChild, MarkdownRenderer, Plugin } from 'obsidian';
import type { CodexCliToolsSettings, PromptTemplate } from './settings';

interface CodexBlockDependencies {
	getSettings: () => CodexCliToolsSettings;
	runPrompt: (prompt: string, options?: {
		model?: string | null;
		reasoningEffort?: string | null;
		onInvocation?: (invocation: { command: string; args: string[] }) => void;
		onOutputChunk?: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => void;
	}) => Promise<string>;
	startExecutionLog: (entry: { timestamp: string; originNote: string; prompt: string }) => Promise<string>;
	setExecutionLogInvocation: (id: string, invocation: { command: string; args: string[] }) => Promise<void>;
	appendExecutionLogOutput: (id: string, stream: 'stdout' | 'stderr', text: string) => Promise<void>;
	completeExecutionLog: (id: string, entry: { response: string; wasError: boolean; durationMs: number }) => Promise<void>;
	getCachedResponse: (promptHash: string) => string | null;
	cacheResponse: (promptHash: string, response: string) => Promise<void>;
}

interface ResolvedPrompt {
	prompt: string;
	templateId: string | null;
	modelOverride: string | null;
	reasoningOverride: string | null;
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

export function registerCodexCodeBlockProcessor(plugin: Plugin, dependencies: CodexBlockDependencies): void {
	plugin.registerMarkdownCodeBlockProcessor('codex', async (source, el, ctx) => {
		const blockEl = el.createDiv({ cls: 'codex-cli-block' });
		const headerEl = blockEl.createDiv({ cls: 'codex-cli-block__header' });
		const statusEl = headerEl.createDiv({ cls: 'codex-cli-block__status' });
		const refreshButtonEl = headerEl.createEl('button', {
			cls: 'codex-cli-block__refresh',
			text: '↻',
		});
		refreshButtonEl.type = 'button';
		refreshButtonEl.ariaLabel = 'Refresh codex output';
		const outputEl = blockEl.createDiv({ cls: 'codex-cli-block__output' });
		let runSequence = 0;

		const isRunActive = (runId: number): boolean => blockEl.isConnected && runId === runSequence;

		const runExecution = async (forceRefresh: boolean): Promise<void> => {
			runSequence += 1;
			const runId = runSequence;
			const timestamp = new Date().toISOString();
			const startedAt = Date.now();
			let executionLogId: string | null = null;
			const promptContext = buildPromptContext(plugin, ctx.sourcePath);

			blockEl.removeClass('is-error');
			blockEl.addClass('is-loading');
			refreshButtonEl.disabled = true;

			try {
				const pluginSettings = dependencies.getSettings();
				const resolvedPrompt = resolvePrompt(source, pluginSettings.promptTemplates);
				const wrappedPrompt = buildStandardizedPrompt(
					resolvedPrompt.prompt,
					promptContext,
					pluginSettings.globalInstructions,
				);
				const wrappedPromptHash = hashPrompt(wrappedPrompt);
				statusEl.setText(
					resolvedPrompt.templateId
						? `Running Codex template "${resolvedPrompt.templateId}"...`
						: 'Running Codex...'
				);
				outputEl.setText(forceRefresh ? 'Refreshing response...' : 'Waiting for response...');

				if (!forceRefresh) {
					const cachedResponse = dependencies.getCachedResponse(wrappedPromptHash);
					if (cachedResponse !== null) {
						if (!isRunActive(runId)) {
							return;
						}

						blockEl.removeClass('is-loading');
						statusEl.setText('Codex result (cached)');
						await renderCodexResponse(plugin, ctx.sourcePath, outputEl, cachedResponse, ctx);
						return;
					}
				}

				executionLogId = await startExecutionLogSafely(dependencies, {
					timestamp,
					originNote: ctx.sourcePath,
					prompt: wrappedPrompt,
				});

				const response = await dependencies.runPrompt(wrappedPrompt, {
					model: resolvedPrompt.modelOverride,
					reasoningEffort: resolvedPrompt.reasoningOverride,
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
						void appendExecutionLogOutputSafely(
							dependencies,
							executionLogId,
							chunk.stream,
							chunk.text,
						);
					},
				});
				await cacheResponseSafely(dependencies, wrappedPromptHash, response);
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
				statusEl.setText(`Codex result generated in ${formatBlockDuration(durationMs)}`);
				await renderCodexResponse(plugin, ctx.sourcePath, outputEl, response, ctx);
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
				statusEl.setText('Codex execution failed');
				outputEl.empty();
				outputEl.createEl('pre', {
					cls: 'codex-cli-block__error',
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

async function renderCodexResponse(
	plugin: Plugin,
	sourcePath: string,
	outputEl: HTMLElement,
	response: string,
	ctx: { addChild: (child: MarkdownRenderChild) => void },
): Promise<void> {
	outputEl.empty();

	if (!response.trim()) {
		outputEl.createEl('p', { text: 'Codex returned an empty response.' });
		return;
	}

	const renderChild = new MarkdownRenderChild(outputEl);
	ctx.addChild(renderChild);
	await MarkdownRenderer.render(plugin.app, response, outputEl, sourcePath, renderChild);
}

function hashPrompt(prompt: string): string {
	return createHash('sha256').update(prompt).digest('hex');
}

function buildPromptContext(plugin: Plugin, sourcePath: string): PromptContext {
	const vaultRootPath = getVaultRootPath(plugin);
	return {
		vaultRootPath,
		currentFilePath: getAbsoluteFilePath(vaultRootPath, sourcePath),
		currentFileVaultPath: sourcePath,
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
	const backlinks = new Set<string>();
	if (!sourcePath) {
		return [];
	}

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
		'You are Codex running inside an Obsidian plugin block.',
		'Use the context below to complete the user instruction.',
		'Start the response with a concise Markdown H3 title derived from the user instruction.',
		'Use Obsidian-flavored Markdown in the output where it helps clarity.',
		'When summarizing, retain and include relevant Obsidian note links (for example [[Note Name]]) from the source context whenever available.',
		'Respond concisely with only the final output that the instruction requests.',
		'Do not include reasoning, thinking, tool or skill selection, or process commentary.',
		'Never mention skills, skill usage, skill selection, or skill file paths in the output.',
		'If there is an issue that prevents completion, return a brief issue message only.',
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
		'',
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
	dependencies: CodexBlockDependencies,
	entry: { timestamp: string; originNote: string; prompt: string },
): Promise<string | null> {
	try {
		return await dependencies.startExecutionLog(entry);
	} catch {
		// Logging must never break markdown rendering.
		return null;
	}
}

async function completeExecutionLogSafely(
	dependencies: CodexBlockDependencies,
	id: string,
	entry: { response: string; wasError: boolean; durationMs: number },
): Promise<void> {
	try {
		await dependencies.completeExecutionLog(id, entry);
	} catch {
		// Logging must never break markdown rendering.
	}
}

async function setExecutionLogInvocationSafely(
	dependencies: CodexBlockDependencies,
	id: string,
	invocation: { command: string; args: string[] },
): Promise<void> {
	try {
		await dependencies.setExecutionLogInvocation(id, invocation);
	} catch {
		// Logging must never break markdown rendering.
	}
}

async function appendExecutionLogOutputSafely(
	dependencies: CodexBlockDependencies,
	id: string,
	stream: 'stdout' | 'stderr',
	text: string,
): Promise<void> {
	try {
		await dependencies.appendExecutionLogOutput(id, stream, text);
	} catch {
		// Logging must never break markdown rendering.
	}
}

async function cacheResponseSafely(
	dependencies: CodexBlockDependencies,
	promptHash: string,
	response: string,
): Promise<void> {
	try {
		await dependencies.cacheResponse(promptHash, response);
	} catch {
		// Cache writes must never break markdown rendering.
	}
}

function resolvePrompt(source: string, templates: PromptTemplate[]): ResolvedPrompt {
	const trimmedSource = source.trim();
	if (!trimmedSource) {
		throw new Error('The codex block is empty. Add a prompt or reference a template.');
	}

	const lines = source.split(/\r?\n/u);
	const directives = extractBlockDirectives(lines);
	const instructionBody = lines.slice(directives.instructionsStartIndex).join('\n').trim();

	if (!directives.templateId) {
		if (!instructionBody) {
			throw new Error('The codex block is empty. Add a prompt or reference a template.');
		}
		return {
			prompt: instructionBody,
			templateId: null,
			modelOverride: directives.modelOverride,
			reasoningOverride: directives.reasoningOverride,
		};
	}

	const template = templates.find((candidate) => candidate.id === directives.templateId);
	if (!template) {
		throw new Error(`No prompt template found for ID "${directives.templateId}".`);
	}

	if (!template.prompt.trim()) {
		throw new Error(`Template "${directives.templateId}" does not contain a prompt.`);
	}

	return {
		prompt: instructionBody ? `${template.prompt}\n\n${instructionBody}` : template.prompt,
		templateId: directives.templateId,
		modelOverride: directives.modelOverride,
		reasoningOverride: directives.reasoningOverride,
	};
}

function extractBlockDirectives(lines: string[]): {
	templateId: string | null;
	modelOverride: string | null;
	reasoningOverride: string | null;
	instructionsStartIndex: number;
} {
	let index = 0;
	while (index < lines.length && lines[index]?.trim().length === 0) {
		index += 1;
	}

	let templateId: string | null = null;
	let modelOverride: string | null = null;
	let reasoningOverride: string | null = null;

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
				throw new Error('Template reference is missing an ID. Use: template: your-template-id');
			}
			templateId = parsedTemplateId;
			index += 1;
			continue;
		}

		const modelMatch = MODEL_REFERENCE_REGEX.exec(trimmed);
		if (modelMatch) {
			const parsedModel = (modelMatch[1] ?? '').trim();
			if (!parsedModel) {
				throw new Error('Model override is missing a value. Use: model: your-model-name');
			}
			modelOverride = parsedModel;
			index += 1;
			continue;
		}

		const reasoningMatch = REASONING_REFERENCE_REGEX.exec(trimmed);
		if (reasoningMatch) {
			const parsedReasoning = (reasoningMatch[2] ?? '').trim();
			if (!parsedReasoning) {
				throw new Error('Reasoning override is missing a value. Use: reasoning: low');
			}
			reasoningOverride = parsedReasoning;
			index += 1;
			continue;
		}

		break;
	}

	return {
		templateId,
		modelOverride,
		reasoningOverride,
		instructionsStartIndex: index,
	};
}

function getErrorMessage(error: unknown): string {
	if (error instanceof Error && error.message) {
		return error.message;
	}
	return 'Unknown error while running Codex.';
}
