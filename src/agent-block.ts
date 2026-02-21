import path from 'path';
import { createHash } from 'crypto';
import { stat } from 'fs/promises';
import { FileSystemAdapter, MarkdownRenderChild, MarkdownRenderer, Plugin, TFile } from 'obsidian';
import type { AgentBlockOverrides, AgentInvocation, AgentOutputChunk } from './agent-types';
import type {
	AgentBlocksSettings,
	AgentTemplate,
	AgentTemplateContextConfig,
	LinkedNoteContentContextConfig,
	LinkedNoteSelectionMode,
} from './settings';

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
	contextConfig: AgentTemplateContextConfig;
}

interface PromptContext {
	vaultRootPath: string;
	currentFilePath: string;
	currentFileVaultPath: string;
	currentNoteContent: string;
	currentNoteAvailable: boolean;
	linkedNoteSnapshots: LinkedNoteSnapshot[];
	linkedNoteContentEnabled: boolean;
	linkedNoteSelectionMode: LinkedNoteSelectionMode;
}

interface LinkedNoteSnapshot {
	path: string;
	relationship: 'outgoing' | 'backlink' | 'outgoing+backlink';
	createdDate: string;
	modifiedDate: string;
	content: string;
	wasTruncated: boolean;
}

interface LinkedNoteCandidate {
	file: TFile;
	createdTimestamp: number;
}

interface BlockContextOverrides {
	linkedNoteContent?: Partial<LinkedNoteContentContextConfig>;
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
const CONTEXT_LINKED_ENABLED_REGEX = /^(context\.linked_note_content\.enabled|linked_content)\s*:\s*(.+)$/iu;
const CONTEXT_LINKED_MAX_NOTES_REGEX = /^(context\.linked_note_content\.max_notes|linked_content_max_notes)\s*:\s*(.+)$/iu;
const CONTEXT_LINKED_MAX_CHARS_REGEX = /^(context\.linked_note_content\.max_chars_per_note|linked_content_max_chars)\s*:\s*(.+)$/iu;
const CONTEXT_LINKED_INCLUDE_OUTGOING_REGEX = /^(context\.linked_note_content\.include_outgoing_links|linked_content_include_outgoing)\s*:\s*(.+)$/iu;
const CONTEXT_LINKED_INCLUDE_BACKLINKS_REGEX = /^(context\.linked_note_content\.include_backlinks|linked_content_include_backlinks)\s*:\s*(.+)$/iu;
const CONTEXT_LINKED_SELECTION_REGEX = /^(context\.linked_note_content\.selection|linked_content_selection)\s*:\s*(.+)$/iu;

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
					const promptContext = await buildPromptContext(plugin, ctx.sourcePath, resolvedBlock.contextConfig);
					const standardizedPrompt = buildStandardizedPrompt(
						resolvedBlock.prompt,
						promptContext,
						dependencies.getSettings().globalInstructions,
					);
					const cacheKey = buildCacheKey(
						standardizedPrompt,
						resolvedBlock.template,
						resolvedBlock.overrides,
						resolvedBlock.contextConfig,
					);

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
		contextConfig: applyContextOverrides(template.context, directives.contextOverrides),
	};
}

function extractBlockDirectives(lines: string[]): {
	templateId: string | null;
	overrides: AgentBlockOverrides;
	contextOverrides: BlockContextOverrides;
	instructionsStartIndex: number;
} {
	let index = 0;
	while (index < lines.length && (lines[index]?.trim().length ?? 0) === 0) {
		index += 1;
	}

	let templateId: string | null = null;
	const overrides: AgentBlockOverrides = {};
	const contextOverrides: BlockContextOverrides = {};

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

		const linkedEnabledMatch = CONTEXT_LINKED_ENABLED_REGEX.exec(trimmed);
		if (linkedEnabledMatch) {
			contextOverrides.linkedNoteContent = {
				...contextOverrides.linkedNoteContent,
				enabled: parseBooleanDirective(
					linkedEnabledMatch[2],
					'Linked content override must be true or false. Use: linked_content: true',
				),
			};
			index += 1;
			continue;
		}

		const linkedMaxNotesMatch = CONTEXT_LINKED_MAX_NOTES_REGEX.exec(trimmed);
		if (linkedMaxNotesMatch) {
			contextOverrides.linkedNoteContent = {
				...contextOverrides.linkedNoteContent,
				maxNotes: parseIntegerDirective(
					linkedMaxNotesMatch[2],
					'Linked content max notes must be an integer. Use: linked_content_max_notes: 5',
				),
			};
			index += 1;
			continue;
		}

		const linkedMaxCharsMatch = CONTEXT_LINKED_MAX_CHARS_REGEX.exec(trimmed);
		if (linkedMaxCharsMatch) {
			contextOverrides.linkedNoteContent = {
				...contextOverrides.linkedNoteContent,
				maxCharsPerNote: parseIntegerDirective(
					linkedMaxCharsMatch[2],
					'Linked content max chars must be an integer. Use: linked_content_max_chars: 2000',
				),
			};
			index += 1;
			continue;
		}

		const linkedSelectionMatch = CONTEXT_LINKED_SELECTION_REGEX.exec(trimmed);
		if (linkedSelectionMatch) {
			contextOverrides.linkedNoteContent = {
				...contextOverrides.linkedNoteContent,
				selectionMode: parseLinkedSelectionDirective(
					linkedSelectionMatch[2],
					'Linked selection override must be "recently-modified" or "recently-created". Use: linked_content_selection: recently-created',
				),
			};
			index += 1;
			continue;
		}

		const linkedIncludeOutgoingMatch = CONTEXT_LINKED_INCLUDE_OUTGOING_REGEX.exec(trimmed);
		if (linkedIncludeOutgoingMatch) {
			contextOverrides.linkedNoteContent = {
				...contextOverrides.linkedNoteContent,
				includeOutgoingLinks: parseBooleanDirective(
					linkedIncludeOutgoingMatch[2],
					'Linked outgoing override must be true or false. Use: linked_content_include_outgoing: true',
				),
			};
			index += 1;
			continue;
		}

		const linkedIncludeBacklinksMatch = CONTEXT_LINKED_INCLUDE_BACKLINKS_REGEX.exec(trimmed);
		if (linkedIncludeBacklinksMatch) {
			contextOverrides.linkedNoteContent = {
				...contextOverrides.linkedNoteContent,
				includeBacklinks: parseBooleanDirective(
					linkedIncludeBacklinksMatch[2],
					'Linked backlinks override must be true or false. Use: linked_content_include_backlinks: false',
				),
			};
			index += 1;
			continue;
		}

		break;
	}

	return {
		templateId,
		overrides,
		contextOverrides,
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

function parseLinkedSelectionDirective(value: string | undefined, message: string): LinkedNoteSelectionMode {
	const normalized = (value ?? '').trim().toLowerCase();
	if (normalized === 'recently-modified') {
		return 'recently-modified';
	}
	if (normalized === 'recently-created') {
		return 'recently-created';
	}
	throw new Error(message);
}

function applyContextOverrides(
	baseContext: AgentTemplateContextConfig,
	overrides: BlockContextOverrides,
): AgentTemplateContextConfig {
	const linkedOverrides = overrides.linkedNoteContent ?? {};
	return {
		linkedNoteContent: {
			selectionMode: normalizeLinkedSelectionMode(
				linkedOverrides.selectionMode ?? baseContext.linkedNoteContent.selectionMode,
			),
			enabled: typeof linkedOverrides.enabled === 'boolean'
				? linkedOverrides.enabled
				: baseContext.linkedNoteContent.enabled,
			maxNotes: normalizeLinkedMaxNotes(linkedOverrides.maxNotes ?? baseContext.linkedNoteContent.maxNotes),
			maxCharsPerNote: normalizeLinkedMaxChars(
				linkedOverrides.maxCharsPerNote ?? baseContext.linkedNoteContent.maxCharsPerNote,
			),
			includeOutgoingLinks: typeof linkedOverrides.includeOutgoingLinks === 'boolean'
				? linkedOverrides.includeOutgoingLinks
				: baseContext.linkedNoteContent.includeOutgoingLinks,
			includeBacklinks: typeof linkedOverrides.includeBacklinks === 'boolean'
				? linkedOverrides.includeBacklinks
				: baseContext.linkedNoteContent.includeBacklinks,
		},
	};
}

function normalizeLinkedMaxNotes(value: number): number {
	if (!Number.isFinite(value)) {
		return 5;
	}
	if (value < 0) {
		return 0;
	}
	if (value > 50) {
		return 50;
	}
	return Math.round(value);
}

function normalizeLinkedMaxChars(value: number): number {
	if (!Number.isFinite(value)) {
		return 2000;
	}
	if (value < 200) {
		return 200;
	}
	if (value > 100_000) {
		return 100_000;
	}
	return Math.round(value);
}

function normalizeLinkedSelectionMode(value: string): LinkedNoteSelectionMode {
	if (value === 'recently-created') {
		return 'recently-created';
	}
	if (value === 'recently-modified') {
		return 'recently-modified';
	}
	return 'recently-modified';
}

function buildCacheKey(
	prompt: string,
	template: AgentTemplate,
	overrides: AgentBlockOverrides,
	contextConfig: AgentTemplateContextConfig,
): string {
	const payload = JSON.stringify({
		prompt,
		templateId: template.id,
		provider: template.provider,
		templateConfig: template.providerConfig,
		contextConfig,
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

async function buildPromptContext(
	plugin: Plugin,
	sourcePath: string,
	contextConfig: AgentTemplateContextConfig,
): Promise<PromptContext> {
	const vaultRootPath = getVaultRootPath(plugin);
	const currentNote = await getCurrentNoteContent(plugin, sourcePath);
	const linkedNoteSnapshots = await getLinkedNoteSnapshots(plugin, sourcePath, contextConfig.linkedNoteContent);
	return {
		vaultRootPath,
		currentFilePath: getAbsoluteFilePath(vaultRootPath, sourcePath),
		currentFileVaultPath: sourcePath || '(current file path unavailable)',
		currentNoteContent: currentNote.content,
		currentNoteAvailable: currentNote.available,
		linkedNoteSnapshots,
		linkedNoteContentEnabled: contextConfig.linkedNoteContent.enabled,
		linkedNoteSelectionMode: contextConfig.linkedNoteContent.selectionMode,
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

async function getCurrentNoteContent(
	plugin: Plugin,
	sourcePath: string,
): Promise<{ content: string; available: boolean }> {
	if (!sourcePath) {
		return {
			content: 'Current note path is unavailable.',
			available: false,
		};
	}

	const abstractFile = plugin.app.vault.getAbstractFileByPath(sourcePath);
	if (!(abstractFile instanceof TFile)) {
		return {
			content: `Current note "${sourcePath}" could not be resolved.`,
			available: false,
		};
	}

	try {
		const content = await plugin.app.vault.cachedRead(abstractFile);
		return {
			content: normalizeLinkedContent(content),
			available: true,
		};
	} catch {
		return {
			content: `Current note "${sourcePath}" could not be read.`,
			available: false,
		};
	}
}

async function getLinkedNoteSnapshots(
	plugin: Plugin,
	sourcePath: string,
	config: LinkedNoteContentContextConfig,
): Promise<LinkedNoteSnapshot[]> {
	if (!config.enabled || config.maxNotes < 1) {
		return [];
	}

	const relationshipByPath = new Map<string, { outgoing: boolean; backlink: boolean }>();
	if (config.includeOutgoingLinks) {
		for (const linkPath of getOutgoingLinkCandidates(plugin, sourcePath)) {
			const linkedFile = resolveLinkedMarkdownFile(plugin, linkPath, sourcePath);
			if (!linkedFile) {
				continue;
			}
			const existing = relationshipByPath.get(linkedFile.path) ?? { outgoing: false, backlink: false };
			existing.outgoing = true;
			relationshipByPath.set(linkedFile.path, existing);
		}
	}
	if (config.includeBacklinks) {
		for (const linkPath of getBacklinks(plugin, sourcePath)) {
			const linkedFile = resolveLinkedMarkdownFile(plugin, linkPath, sourcePath);
			if (!linkedFile) {
				continue;
			}
			const existing = relationshipByPath.get(linkedFile.path) ?? { outgoing: false, backlink: false };
			existing.backlink = true;
			relationshipByPath.set(linkedFile.path, existing);
		}
	}

	relationshipByPath.delete(sourcePath);
	const candidateFiles = [...relationshipByPath.keys()]
		.map((linkedPath) => resolveLinkedMarkdownFile(plugin, linkedPath, sourcePath))
		.filter((file): file is TFile => file !== null);
	const fileSystemAdapter = getFileSystemAdapter(plugin);
	const candidates = await Promise.all(candidateFiles.map(async (file) => ({
		file,
		createdTimestamp: await getCreatedTimestamp(fileSystemAdapter, file),
	})));
	candidates.sort((a, b) => compareLinkedNoteCandidates(a, b, config.selectionMode));
	const snapshots: LinkedNoteSnapshot[] = [];

	for (const candidate of candidates) {
		if (snapshots.length >= config.maxNotes) {
			break;
		}
		const candidateFile = candidate.file;
		const linkedPath = candidateFile.path;

		try {
			const rawContent = await plugin.app.vault.cachedRead(candidateFile);
			const normalizedContent = normalizeLinkedContent(rawContent);
			if (!normalizedContent.trim()) {
				continue;
			}

			const trimmedContent = normalizedContent.slice(0, config.maxCharsPerNote);
			const wasTruncated = normalizedContent.length > config.maxCharsPerNote;
			const relationship = relationshipByPath.get(linkedPath) ?? { outgoing: false, backlink: false };
			snapshots.push({
				path: linkedPath,
				relationship: getRelationshipLabel(relationship),
				createdDate: formatXmlDate(candidate.createdTimestamp),
				modifiedDate: formatXmlDate(candidateFile.stat.mtime),
				content: trimmedContent,
				wasTruncated,
			});
		} catch {
			// Skip unreadable files without failing the block.
		}
	}

	return snapshots;
}

function resolveLinkedMarkdownFile(plugin: Plugin, linkPath: string, sourcePath: string): TFile | null {
	const direct = plugin.app.vault.getAbstractFileByPath(linkPath);
	if (direct instanceof TFile && direct.extension === 'md') {
		return direct;
	}

	if (!linkPath.endsWith('.md')) {
		const withMd = plugin.app.vault.getAbstractFileByPath(`${linkPath}.md`);
		if (withMd instanceof TFile && withMd.extension === 'md') {
			return withMd;
		}
	}

	const resolved = plugin.app.metadataCache.getFirstLinkpathDest(linkPath, sourcePath);
	if (resolved instanceof TFile && resolved.extension === 'md') {
		return resolved;
	}

	if (linkPath.endsWith('.md')) {
		const withoutExt = linkPath.slice(0, -3);
		const resolvedWithoutExt = plugin.app.metadataCache.getFirstLinkpathDest(withoutExt, sourcePath);
		if (resolvedWithoutExt instanceof TFile && resolvedWithoutExt.extension === 'md') {
			return resolvedWithoutExt;
		}
	}

	return null;
}

function compareLinkedNoteCandidates(
	a: LinkedNoteCandidate,
	b: LinkedNoteCandidate,
	mode: LinkedNoteSelectionMode,
): number {
	if (mode === 'recently-created') {
		const byCreatedTimestamp = b.createdTimestamp - a.createdTimestamp;
		if (byCreatedTimestamp !== 0) {
			return byCreatedTimestamp;
		}
	}

	const byMtime = b.file.stat.mtime - a.file.stat.mtime;
	if (byMtime !== 0) {
		return byMtime;
	}

	return a.file.path.localeCompare(b.file.path);
}

function getOutgoingLinkCandidates(plugin: Plugin, sourcePath: string): string[] {
	const resolved = plugin.app.metadataCache.resolvedLinks[sourcePath] ?? {};
	const unresolved = plugin.app.metadataCache.unresolvedLinks[sourcePath] ?? {};
	const candidates = new Set<string>();
	for (const path of Object.keys(resolved)) {
		candidates.add(path);
	}
	for (const path of Object.keys(unresolved)) {
		candidates.add(path);
	}
	return [...candidates];
}

function normalizeLinkedContent(content: string): string {
	return content.replace(/\r\n/g, '\n');
}

function getRelationshipLabel(relationship: { outgoing: boolean; backlink: boolean }): LinkedNoteSnapshot['relationship'] {
	if (relationship.outgoing && relationship.backlink) {
		return 'outgoing+backlink';
	}
	if (relationship.backlink) {
		return 'backlink';
	}
	return 'outgoing';
}

function getFileSystemAdapter(plugin: Plugin): FileSystemAdapter | null {
	const adapter = plugin.app.vault.adapter;
	if (adapter instanceof FileSystemAdapter) {
		return adapter;
	}
	return null;
}

async function getCreatedTimestamp(fileSystemAdapter: FileSystemAdapter | null, file: TFile): Promise<number> {
	if (fileSystemAdapter) {
		const normalizedFilePath = file.path.split('/').join(path.sep);
		const absoluteFilePath = path.join(fileSystemAdapter.getBasePath(), normalizedFilePath);
		try {
			const fileStats = await stat(absoluteFilePath);
			if (Number.isFinite(fileStats.birthtimeMs) && fileStats.birthtimeMs > 0) {
				return fileStats.birthtimeMs;
			}
		} catch {
			// Fall back to Obsidian metadata.
		}
	}

	if (Number.isFinite(file.stat.ctime) && file.stat.ctime > 0) {
		return file.stat.ctime;
	}
	if (Number.isFinite(file.stat.mtime) && file.stat.mtime > 0) {
		return file.stat.mtime;
	}
	return 0;
}

function buildStandardizedPrompt(
	userInstruction: string,
	context: PromptContext,
	globalInstructions: string,
): string {
	const trimmedGlobalInstructions = globalInstructions.trim();
	const instructionText = userInstruction.trim();

	return [
		'<response_contract>',
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
		'</response_contract>',
		'<context>',
		'  <environment>',
		`    <vault_root_path>${escapeXml(context.vaultRootPath)}</vault_root_path>`,
		`    <current_file_path>${escapeXml(context.currentFilePath)}</current_file_path>`,
		`    <current_file_vault_path>${escapeXml(context.currentFileVaultPath)}</current_file_vault_path>`,
		'  </environment>',
		`  <current_note available="${context.currentNoteAvailable ? 'true' : 'false'}">`,
		escapeXml(context.currentNoteContent),
		'  </current_note>',
		`  <linked_note_content enabled="${context.linkedNoteContentEnabled ? 'true' : 'false'}" selection_mode="${escapeXml(context.linkedNoteSelectionMode)}">`,
		context.linkedNoteSnapshots.length > 0
			? formatLinkedNoteSnapshots(context.linkedNoteSnapshots)
			: 'No linked notes were loaded.',
		'  </linked_note_content>',
		'</context>',
		...(trimmedGlobalInstructions
			? [
				'<global_instructions>',
				escapeXml(trimmedGlobalInstructions),
				'</global_instructions>',
			]
			: []),
		'<instructions>',
		escapeXml(instructionText),
		'</instructions>',
	].join('\n');
}

function formatLinkedNoteSnapshots(snapshots: LinkedNoteSnapshot[]): string {
	return snapshots
		.map((snapshot) => [
			`    <linked_note path="${escapeXml(snapshot.path)}" relationship="${escapeXml(snapshot.relationship)}" created_date="${escapeXml(snapshot.createdDate)}" modified_date="${escapeXml(snapshot.modifiedDate)}" truncated="${snapshot.wasTruncated ? 'true' : 'false'}">`,
			escapeXml(snapshot.content),
			'    </linked_note>',
		].join('\n'))
		.join('\n\n');
}

function formatXmlDate(value: number): string {
	if (!Number.isFinite(value) || value <= 0) {
		return '';
	}
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return '';
	}
	return date.toISOString().slice(0, 10);
}

function escapeXml(value: string): string {
	return value
		.split('&')
		.join('&amp;')
		.split('<')
		.join('&lt;')
		.split('>')
		.join('&gt;');
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
