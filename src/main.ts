import { Plugin } from 'obsidian';
import type { AgentBlockOverrides, AgentInvocation, AgentOutputChunk, AgentProviderId } from './agent-types';
import { registerAgentCodeBlockProcessor } from './agent-block';
import { CodexCliProvider } from './providers/codex-provider';
import { OllamaProvider } from './providers/ollama-provider';
import {
	type AgentCacheMode,
	type AgentBlocksSettings,
	type AgentTemplate,
	type AgentTemplateContextConfig,
	type CodexAgentProviderConfig,
	type ExecutionLogEntry,
	type LinkedNoteContentContextConfig,
	type LinkedNoteSortDirection,
	type LinkedNoteSortField,
	type PromptCacheEntry,
	type OllamaAgentProviderConfig,
	AgentSettingTab,
	DEFAULT_CODEX_PROVIDER_CONFIG,
	DEFAULT_OLLAMA_PROVIDER_CONFIG,
	DEFAULT_TEMPLATE_CONTEXT_CONFIG,
	DEFAULT_SETTINGS,
	createDefaultCodexAgentTemplate,
	createDefaultTemplateContextConfig,
	createTemplateId,
} from './settings';

const MAX_EXECUTION_LOG_ENTRIES = 100;
const MAX_PROCESS_OUTPUT_CHARS = 100_000;
const PROCESS_OUTPUT_SAVE_INTERVAL_MS = 500;

interface ProcessOutputState {
	atLineStart: boolean;
	lastStream: 'stdout' | 'stderr' | null;
}

const USER_CANCELLED_MESSAGE = 'Agent execution canceled by user.';

export default class AgentBlocksPlugin extends Plugin {
	settings!: AgentBlocksSettings;
	private readonly codexProvider = new CodexCliProvider();
	private readonly ollamaProvider = new OllamaProvider();
	private readonly lastProcessOutputSaveAtByLogId = new Map<string, number>();
	private readonly processOutputStateByLogId = new Map<string, ProcessOutputState>();
	private readonly cancelExecutionByLogId = new Map<string, () => void>();
	private settingTab: AgentSettingTab | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		registerAgentCodeBlockProcessor(this, {
			getSettings: () => this.settings,
			resolveTemplate: (templateId) => this.resolveTemplate(templateId),
			runAgent: (request) => this.runAgent(request),
			startExecutionLog: async (entry) => this.startExecutionLog(entry),
			setExecutionLogInvocation: async (id, invocation) => this.setExecutionLogInvocation(id, invocation),
			appendExecutionLogOutput: async (id, stream, text) => this.appendExecutionLogOutput(id, stream, text),
			completeExecutionLog: async (id, entry) => this.completeExecutionLog(id, entry),
			cancelExecutionLogRun: async (id) => this.cancelExecutionLogRun(id),
			getCachedResponse: (promptHash: string) => this.settings.promptCache[promptHash]?.response ?? null,
			cacheResponse: async (promptHash: string, response: string) => this.saveCachedResponse(promptHash, response),
			getBlockPromptCacheKey: (blockCacheId: string) => this.getBlockPromptCacheKey(blockCacheId),
			setBlockPromptCacheKey: async (blockCacheId: string, promptHash: string) => this.setBlockPromptCacheKey(blockCacheId, promptHash),
		});

		this.settingTab = new AgentSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);
	}

	onunload(): void {
		this.codexProvider.dispose();
		this.ollamaProvider.dispose?.();
		for (const cancel of this.cancelExecutionByLogId.values()) {
			cancel();
		}
		this.cancelExecutionByLogId.clear();
		this.settingTab = null;
	}

	async loadSettings(): Promise<void> {
		const loaded = await this.loadData() as Record<string, unknown> | null;
		this.settings = migrateAndNormalizeSettings(loaded);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	async applyPromptCacheLimit(): Promise<void> {
		this.settings.promptCacheMaxEntries = normalizePromptCacheMaxEntries(this.settings.promptCacheMaxEntries);
		enforcePromptCacheLimit(this.settings.promptCache, this.settings.promptCacheMaxEntries);
		pruneBlockPromptCacheIndex(this.settings.blockPromptCacheIndex, this.settings.promptCache);
		await this.saveSettings();
	}

	private resolveTemplate(templateId: string | null): AgentTemplate | null {
		if (templateId) {
			return this.settings.agentTemplates.find((template) => template.id === templateId) ?? null;
		}

		const defaultTemplate = this.settings.agentTemplates.find(
			(template) => template.id === this.settings.defaultAgentTemplateId,
		);
		if (defaultTemplate) {
			return defaultTemplate;
		}

		return this.settings.agentTemplates[0] ?? null;
	}

	private async runAgent(request: {
		template: AgentTemplate;
		prompt: string;
		overrides: AgentBlockOverrides;
		executionLogId?: string;
		onInvocation?: (invocation: AgentInvocation) => void;
		onOutputChunk?: (chunk: AgentOutputChunk) => void;
	}): Promise<string> {
		const abortController = new AbortController();
		let settled = false;
		let cancelled = false;

		return await new Promise<string>((resolve, reject) => {
			const finishResolve = (value: string): void => {
				if (settled) {
					return;
				}
				settled = true;
				if (request.executionLogId) {
					this.cancelExecutionByLogId.delete(request.executionLogId);
				}
				resolve(value);
			};

			const finishReject = (error: Error): void => {
				if (settled) {
					return;
				}
				settled = true;
				if (request.executionLogId) {
					this.cancelExecutionByLogId.delete(request.executionLogId);
				}
				reject(error);
			};

			const cancel = (): void => {
				if (settled || cancelled) {
					return;
				}
				cancelled = true;
				abortController.abort();
				finishReject(new Error(USER_CANCELLED_MESSAGE));
			};

			if (request.executionLogId) {
				this.cancelExecutionByLogId.set(request.executionLogId, cancel);
			}

			const runRequest = {
				template: request.template,
				prompt: request.prompt,
				overrides: request.overrides,
				abortSignal: abortController.signal,
				onInvocation: (invocation: AgentInvocation) => {
					if (settled || cancelled) {
						return;
					}
					request.onInvocation?.(invocation);
				},
				onOutputChunk: (chunk: AgentOutputChunk) => {
					if (settled || cancelled) {
						return;
					}
					request.onOutputChunk?.(chunk);
				},
			};

			const runPromise = request.template.provider === 'codex'
				? this.codexProvider.run(runRequest)
				: this.ollamaProvider.run(runRequest);

			runPromise
				.then((result) => {
					if (cancelled || abortController.signal.aborted) {
						finishReject(new Error(USER_CANCELLED_MESSAGE));
						return;
					}
					finishResolve(result.response);
				})
				.catch((error: unknown) => {
					if (cancelled || abortController.signal.aborted) {
						finishReject(new Error(USER_CANCELLED_MESSAGE));
						return;
					}

					if (error instanceof Error) {
						finishReject(error);
						return;
					}
					finishReject(new Error(String(error)));
				});
		});
	}

	async cancelExecutionLogRun(id: string): Promise<boolean> {
		const cancel = this.cancelExecutionByLogId.get(id);
		if (!cancel) {
			return false;
		}
		cancel();
		this.settingTab?.notifyExecutionLogUpdated();
		return true;
	}

	private async startExecutionLog(entry: {
		timestamp: string;
		originNote: string;
		agentTemplateId: string;
		agentTemplateName: string;
		provider: AgentProviderId;
		prompt: string;
	}): Promise<string> {
		const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
		this.settings.executionLog.unshift({
			id,
			timestamp: entry.timestamp,
			originNote: entry.originNote,
			agentTemplateId: entry.agentTemplateId,
			agentTemplateName: entry.agentTemplateName,
			provider: entry.provider,
			prompt: entry.prompt,
			command: '',
			commandArgs: [],
			response: '',
			processOutput: '',
			wasError: false,
			durationMs: Number.NaN,
			status: 'running',
		});
		this.processOutputStateByLogId.set(id, { atLineStart: true, lastStream: null });
		if (this.settings.executionLog.length > MAX_EXECUTION_LOG_ENTRIES) {
			this.settings.executionLog = this.settings.executionLog.slice(0, MAX_EXECUTION_LOG_ENTRIES);
			const retainedIds = new Set(this.settings.executionLog.map((logEntry) => logEntry.id));
			for (const logId of this.lastProcessOutputSaveAtByLogId.keys()) {
				if (!retainedIds.has(logId)) {
					this.lastProcessOutputSaveAtByLogId.delete(logId);
				}
			}
			for (const logId of this.processOutputStateByLogId.keys()) {
				if (!retainedIds.has(logId)) {
					this.processOutputStateByLogId.delete(logId);
				}
			}
			for (const logId of this.cancelExecutionByLogId.keys()) {
				if (!retainedIds.has(logId)) {
					this.cancelExecutionByLogId.delete(logId);
				}
			}
		}
		await this.saveSettings();
		this.settingTab?.notifyExecutionLogUpdated();
		return id;
	}

	private async setExecutionLogInvocation(id: string, invocation: AgentInvocation): Promise<void> {
		const existing = this.settings.executionLog.find((logEntry) => logEntry.id === id);
		if (!existing) {
			return;
		}

		existing.command = invocation.command;
		existing.commandArgs = [...invocation.args];
		await this.saveSettings();
		this.settingTab?.notifyExecutionLogUpdated();
	}

	private async appendExecutionLogOutput(
		id: string,
		stream: 'stdout' | 'stderr',
		text: string,
	): Promise<void> {
		if (!text) {
			return;
		}

		const existing = this.settings.executionLog.find((logEntry) => logEntry.id === id);
		if (!existing) {
			return;
		}

		const state = this.processOutputStateByLogId.get(id) ?? { atLineStart: true, lastStream: null };
		const formattedChunk = formatProcessOutputChunk(state, stream, text);
		this.processOutputStateByLogId.set(id, state);
		existing.processOutput = trimProcessOutput(`${existing.processOutput}${formattedChunk}`);

		const now = Date.now();
		const lastSavedAt = this.lastProcessOutputSaveAtByLogId.get(id) ?? 0;
		if (now - lastSavedAt < PROCESS_OUTPUT_SAVE_INTERVAL_MS) {
			this.settingTab?.notifyExecutionLogUpdated();
			return;
		}

		this.lastProcessOutputSaveAtByLogId.set(id, now);
		await this.saveSettings();
		this.settingTab?.notifyExecutionLogUpdated();
	}

	private async completeExecutionLog(
		id: string,
		entry: {
			response: string;
			wasError: boolean;
			durationMs: number;
			status?: 'success' | 'error' | 'stopped';
		},
	): Promise<void> {
		const existing = this.settings.executionLog.find((logEntry) => logEntry.id === id);
		if (!existing) {
			return;
		}

		existing.response = entry.response;
		existing.durationMs = entry.durationMs;
		existing.status = entry.status ?? (entry.wasError ? 'error' : 'success');
		existing.wasError = existing.status === 'error';
		this.lastProcessOutputSaveAtByLogId.delete(id);
		this.processOutputStateByLogId.delete(id);
		this.cancelExecutionByLogId.delete(id);
		await this.saveSettings();
		this.settingTab?.notifyExecutionLogUpdated();
	}

	private async saveCachedResponse(promptHash: string, response: string): Promise<void> {
		this.settings.promptCache[promptHash] = {
			response,
			cachedAt: new Date().toISOString(),
		};
		enforcePromptCacheLimit(this.settings.promptCache, this.settings.promptCacheMaxEntries);
		pruneBlockPromptCacheIndex(this.settings.blockPromptCacheIndex, this.settings.promptCache);
		await this.saveSettings();
	}

	private getBlockPromptCacheKey(blockCacheId: string): string | null {
		if (!blockCacheId) {
			return null;
		}
		const hash = this.settings.blockPromptCacheIndex[blockCacheId];
		return typeof hash === 'string' && hash.trim() ? hash : null;
	}

	private async setBlockPromptCacheKey(blockCacheId: string, promptHash: string): Promise<void> {
		const normalizedBlockId = blockCacheId.trim();
		if (!normalizedBlockId) {
			return;
		}

		const normalizedPromptHash = promptHash.trim();
		if (!normalizedPromptHash) {
			delete this.settings.blockPromptCacheIndex[normalizedBlockId];
			await this.saveSettings();
			return;
		}

		this.settings.blockPromptCacheIndex[normalizedBlockId] = normalizedPromptHash;
		await this.saveSettings();
	}
}

function migrateAndNormalizeSettings(loadedData: Record<string, unknown> | null): AgentBlocksSettings {
	const loaded = loadedData ?? {};
	const migratedTemplates = migrateAgentTemplates(loaded);
	const defaultTemplateId = normalizeDefaultTemplateId(
		loaded.defaultAgentTemplateId,
		migratedTemplates,
	);

	const normalizedLog = normalizeExecutionLog(loaded.executionLog);
	const normalizedCache = normalizePromptCache(loaded.promptCache);
	const promptCacheMaxEntries = normalizePromptCacheMaxEntries(loaded.promptCacheMaxEntries);
	enforcePromptCacheLimit(normalizedCache, promptCacheMaxEntries);
	const normalizedBlockPromptCacheIndex = normalizeBlockPromptCacheIndex(
		loaded.blockPromptCacheIndex,
		normalizedCache,
	);

	return {
		globalInstructions: typeof loaded.globalInstructions === 'string' ? loaded.globalInstructions : '',
		agentTemplates: migratedTemplates,
		defaultAgentTemplateId: defaultTemplateId,
		promptCacheMaxEntries,
		executionLog: normalizedLog,
		promptCache: normalizedCache,
		blockPromptCacheIndex: normalizedBlockPromptCacheIndex,
	};
}

function migrateAgentTemplates(loaded: Record<string, unknown>): AgentTemplate[] {
	if (Array.isArray(loaded.agentTemplates)) {
		const normalized = loaded.agentTemplates
			.map((template) => normalizeAgentTemplate(template))
			.filter((template): template is AgentTemplate => template !== null);
		if (normalized.length > 0) {
			return normalized;
		}
	}

	const legacyPromptTemplates = parseLegacyPromptTemplates(loaded.promptTemplates);
	const legacyCodexConfig = parseLegacyCodexConfig(loaded);

	const migratedFromLegacyTemplates = legacyPromptTemplates.map((legacyTemplate) => ({
		id: legacyTemplate.id,
		name: legacyTemplate.name,
		instructions: legacyTemplate.prompt,
		cacheMode: 'auto-refresh' as const,
		context: createDefaultTemplateContextConfig(),
		provider: 'codex' as const,
		providerConfig: { ...legacyCodexConfig },
	}));

	if (migratedFromLegacyTemplates.length > 0) {
		return migratedFromLegacyTemplates;
	}

	const defaultId = 'default-agent';
	const defaultTemplate = createDefaultCodexAgentTemplate(defaultId);
	defaultTemplate.providerConfig = { ...legacyCodexConfig };
	return [defaultTemplate];
}

function normalizeAgentTemplate(value: unknown): AgentTemplate | null {
	if (!value || typeof value !== 'object') {
		return null;
	}

	const raw = value as Record<string, unknown>;
	const provider = raw.provider === 'ollama' ? 'ollama' : 'codex';
	const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : createTemplateId([]);
	const name = typeof raw.name === 'string' && raw.name.trim()
		? raw.name
		: (provider === 'codex' ? 'Codex agent' : 'Ollama agent');
	const instructions = typeof raw.instructions === 'string' ? raw.instructions : '';

	if (provider === 'codex') {
		return {
			id,
			name,
			instructions,
			cacheMode: normalizeAgentCacheMode(raw.cacheMode),
			context: normalizeTemplateContext(raw.context),
			provider,
			providerConfig: normalizeCodexConfig(raw.providerConfig),
		};
	}

	return {
		id,
		name,
		instructions,
		cacheMode: normalizeAgentCacheMode(raw.cacheMode),
		context: normalizeTemplateContext(raw.context),
		provider,
		providerConfig: normalizeOllamaConfig(raw.providerConfig),
	};
}

function normalizeAgentCacheMode(value: unknown): AgentCacheMode {
	if (value === 'prefer-cache') {
		return 'prefer-cache';
	}
	return 'auto-refresh';
}

function normalizeTemplateContext(value: unknown): AgentTemplateContextConfig {
	if (!value || typeof value !== 'object') {
		return createDefaultTemplateContextConfig();
	}
	const raw = value as Record<string, unknown>;
	return {
		linkedNoteContent: normalizeLinkedNoteContentContext(raw.linkedNoteContent),
	};
}

function normalizeLinkedNoteContentContext(value: unknown): LinkedNoteContentContextConfig {
	if (!value || typeof value !== 'object') {
		return createDefaultTemplateContextConfig().linkedNoteContent;
	}
	const raw = value as Record<string, unknown>;
	const rawFilters = raw.filters && typeof raw.filters === 'object'
		? raw.filters as Record<string, unknown>
		: null;
	const rawSort = raw.sort && typeof raw.sort === 'object'
		? raw.sort as Record<string, unknown>
		: null;

	return {
		enabled: typeof raw.enabled === 'boolean'
			? raw.enabled
			: DEFAULT_TEMPLATE_CONTEXT_CONFIG.linkedNoteContent.enabled,
		maxNotes: normalizeLinkedMaxNotes(raw.maxNotes),
		maxCharsPerNote: normalizeLinkedMaxChars(raw.maxCharsPerNote),
		filters: {
			includeOutgoingLinks: typeof rawFilters?.includeOutgoingLinks === 'boolean'
				? rawFilters.includeOutgoingLinks
				: (typeof raw.includeOutgoingLinks === 'boolean'
					? raw.includeOutgoingLinks
					: DEFAULT_TEMPLATE_CONTEXT_CONFIG.linkedNoteContent.filters.includeOutgoingLinks),
			includeBacklinks: typeof rawFilters?.includeBacklinks === 'boolean'
				? rawFilters.includeBacklinks
				: (typeof raw.includeBacklinks === 'boolean'
					? raw.includeBacklinks
					: DEFAULT_TEMPLATE_CONTEXT_CONFIG.linkedNoteContent.filters.includeBacklinks),
			requiredFrontmatterField: normalizeOptionalString(
				rawFilters?.requiredFrontmatterField ?? raw.requiredFrontmatterField,
			),
		},
		sort: {
			field: normalizeLinkedSortField(rawSort?.field ?? raw.selectionMode),
			direction: normalizeLinkedSortDirection(rawSort?.direction),
			frontmatterDateField: normalizeOptionalString(rawSort?.frontmatterDateField),
		},
	};
}

function normalizeLinkedSortField(value: unknown): LinkedNoteSortField {
	if (typeof value !== 'string') {
		return DEFAULT_TEMPLATE_CONTEXT_CONFIG.linkedNoteContent.sort.field;
	}
	const normalized = value.trim().toLowerCase();
	if (normalized === 'created-date' || normalized === 'recently-created') {
		return 'created-date';
	}
	if (normalized === 'frontmatter-date') {
		return 'frontmatter-date';
	}
	if (normalized === 'modified-date' || normalized === 'recently-modified') {
		return 'modified-date';
	}
	return DEFAULT_TEMPLATE_CONTEXT_CONFIG.linkedNoteContent.sort.field;
}

function normalizeLinkedSortDirection(value: unknown): LinkedNoteSortDirection {
	if (typeof value !== 'string') {
		return DEFAULT_TEMPLATE_CONTEXT_CONFIG.linkedNoteContent.sort.direction;
	}
	const normalized = value.trim().toLowerCase();
	if (normalized === 'ascending') {
		return 'ascending';
	}
	if (normalized === 'descending') {
		return 'descending';
	}
	return DEFAULT_TEMPLATE_CONTEXT_CONFIG.linkedNoteContent.sort.direction;
}

function normalizeOptionalString(value: unknown): string {
	if (typeof value !== 'string') {
		return '';
	}
	return value.trim();
}

function normalizeCodexConfig(value: unknown): CodexAgentProviderConfig {
	if (!value || typeof value !== 'object') {
		return { ...DEFAULT_CODEX_PROVIDER_CONFIG };
	}
	const raw = value as Record<string, unknown>;
	return {
		command: typeof raw.command === 'string' && raw.command.trim()
			? raw.command.trim()
			: DEFAULT_CODEX_PROVIDER_CONFIG.command,
		arguments: typeof raw.arguments === 'string'
			? raw.arguments
			: DEFAULT_CODEX_PROVIDER_CONFIG.arguments,
		model: typeof raw.model === 'string' ? raw.model.trim() : '',
		reasoningEffort: typeof raw.reasoningEffort === 'string' ? raw.reasoningEffort.trim() : '',
		useOssModelProvider: typeof raw.useOssModelProvider === 'boolean'
			? raw.useOssModelProvider
			: DEFAULT_CODEX_PROVIDER_CONFIG.useOssModelProvider,
		localProvider: typeof raw.localProvider === 'string' ? raw.localProvider.trim() : '',
		executionTimeoutSeconds: normalizeTimeoutSeconds(raw.executionTimeoutSeconds),
		enableMcpServers: typeof raw.enableMcpServers === 'boolean'
			? raw.enableMcpServers
			: DEFAULT_CODEX_PROVIDER_CONFIG.enableMcpServers,
	};
}

function normalizeOllamaConfig(value: unknown): OllamaAgentProviderConfig {
	if (!value || typeof value !== 'object') {
		return { ...DEFAULT_OLLAMA_PROVIDER_CONFIG };
	}
	const raw = value as Record<string, unknown>;
	return {
		host: typeof raw.host === 'string' && raw.host.trim()
			? raw.host.trim()
			: DEFAULT_OLLAMA_PROVIDER_CONFIG.host,
		model: typeof raw.model === 'string' && raw.model.trim()
			? raw.model.trim()
			: DEFAULT_OLLAMA_PROVIDER_CONFIG.model,
		temperature: normalizeTemperature(raw.temperature),
		numPredict: normalizeNumPredict(raw.numPredict),
		keepAlive: typeof raw.keepAlive === 'string' && raw.keepAlive.trim()
			? raw.keepAlive.trim()
			: DEFAULT_OLLAMA_PROVIDER_CONFIG.keepAlive,
	};
}

function normalizeTimeoutSeconds(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return DEFAULT_CODEX_PROVIDER_CONFIG.executionTimeoutSeconds;
	}
	if (value < 15) {
		return 15;
	}
	if (value > 3600) {
		return 3600;
	}
	return Math.round(value);
}

function normalizeTemperature(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return DEFAULT_OLLAMA_PROVIDER_CONFIG.temperature;
	}
	if (value < 0) {
		return 0;
	}
	if (value > 2) {
		return 2;
	}
	return Number(value.toFixed(2));
}

function normalizeNumPredict(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return DEFAULT_OLLAMA_PROVIDER_CONFIG.numPredict;
	}
	if (value < 1) {
		return 1;
	}
	if (value > 32768) {
		return 32768;
	}
	return Math.round(value);
}

function normalizePromptCacheMaxEntries(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return DEFAULT_SETTINGS.promptCacheMaxEntries;
	}
	const rounded = Math.round(value);
	if (rounded < 1) {
		return 1;
	}
	if (rounded > 50_000) {
		return 50_000;
	}
	return rounded;
}

function normalizeLinkedMaxNotes(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return DEFAULT_TEMPLATE_CONTEXT_CONFIG.linkedNoteContent.maxNotes;
	}
	if (value < 0) {
		return 0;
	}
	if (value > 50) {
		return 50;
	}
	return Math.round(value);
}

function normalizeLinkedMaxChars(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return DEFAULT_TEMPLATE_CONTEXT_CONFIG.linkedNoteContent.maxCharsPerNote;
	}
	if (value < 200) {
		return 200;
	}
	if (value > 100_000) {
		return 100_000;
	}
	return Math.round(value);
}

function normalizeDefaultTemplateId(defaultId: unknown, templates: AgentTemplate[]): string {
	if (typeof defaultId === 'string' && templates.some((template) => template.id === defaultId)) {
		return defaultId;
	}
	return templates[0]?.id ?? DEFAULT_SETTINGS.defaultAgentTemplateId;
}

function normalizeExecutionLog(value: unknown): ExecutionLogEntry[] {
	if (!Array.isArray(value)) {
		return [];
	}

	return value
		.map((entry) => normalizeExecutionLogEntry(entry))
		.filter((entry): entry is ExecutionLogEntry => entry !== null);
}

function normalizeExecutionLogEntry(value: unknown): ExecutionLogEntry | null {
	if (!value || typeof value !== 'object') {
		return null;
	}
	const raw = value as Record<string, unknown>;
	const status = raw.status === 'running' || raw.status === 'success' || raw.status === 'error' || raw.status === 'stopped'
		? raw.status
		: (raw.wasError ? 'error' : 'success');

	return {
		id: typeof raw.id === 'string' ? raw.id : `${Date.now()}-${Math.random().toString(16).slice(2)}`,
		timestamp: typeof raw.timestamp === 'string' ? raw.timestamp : new Date().toISOString(),
		originNote: typeof raw.originNote === 'string' ? raw.originNote : '',
		agentTemplateId: typeof raw.agentTemplateId === 'string' ? raw.agentTemplateId : '',
		agentTemplateName: typeof raw.agentTemplateName === 'string' ? raw.agentTemplateName : 'Unknown agent',
		provider: raw.provider === 'ollama' ? 'ollama' : 'codex',
		prompt: typeof raw.prompt === 'string' ? raw.prompt : '',
		command: typeof raw.command === 'string' ? raw.command : '',
		commandArgs: Array.isArray(raw.commandArgs)
			? raw.commandArgs.filter((arg): arg is string => typeof arg === 'string')
			: [],
		response: typeof raw.response === 'string' ? raw.response : '',
		processOutput: typeof raw.processOutput === 'string' ? raw.processOutput : '',
		wasError: status === 'error',
		durationMs: typeof raw.durationMs === 'number' ? raw.durationMs : Number.NaN,
		status: status === 'running' ? 'error' : status,
	};
}

function normalizePromptCache(value: unknown): Record<string, PromptCacheEntry> {
	if (!value || typeof value !== 'object') {
		return {};
	}

	return Object.fromEntries(
		Object.entries(value)
			.filter(([, cacheEntry]) => {
				if (!cacheEntry || typeof cacheEntry !== 'object') {
					return false;
				}
				const raw = cacheEntry as Record<string, unknown>;
				return typeof raw.response === 'string' && typeof raw.cachedAt === 'string';
			}),
	) as Record<string, PromptCacheEntry>;
}

function normalizeBlockPromptCacheIndex(
	value: unknown,
	cache: Record<string, PromptCacheEntry>,
): Record<string, string> {
	if (!value || typeof value !== 'object') {
		return {};
	}

	const normalized = Object.fromEntries(
		Object.entries(value)
			.filter(([blockId, hash]) => {
				if (typeof blockId !== 'string' || !blockId.trim()) {
					return false;
				}
				if (typeof hash !== 'string' || !hash.trim()) {
					return false;
				}
				return typeof cache[hash]?.response === 'string';
			})
			.map(([blockId, hash]) => [blockId, (hash as string).trim()]),
	) as Record<string, string>;

	return normalized;
}

function parseLegacyPromptTemplates(value: unknown): Array<{ id: string; name: string; prompt: string }> {
	if (!Array.isArray(value)) {
		return [];
	}

	const templates: Array<{ id: string; name: string; prompt: string }> = [];
	for (const candidate of value) {
		if (!candidate || typeof candidate !== 'object') {
			continue;
		}
		const raw = candidate as Record<string, unknown>;
		const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : '';
		if (!id) {
			continue;
		}
		templates.push({
			id,
			name: typeof raw.name === 'string' && raw.name.trim() ? raw.name : id,
			prompt: typeof raw.prompt === 'string' ? raw.prompt : '',
		});
	}
	return templates;
}

function parseLegacyCodexConfig(loaded: Record<string, unknown>): CodexAgentProviderConfig {
	return {
		command: typeof loaded.codexCommand === 'string' && loaded.codexCommand.trim()
			? loaded.codexCommand.trim()
			: DEFAULT_CODEX_PROVIDER_CONFIG.command,
		arguments: typeof loaded.codexArguments === 'string'
			? loaded.codexArguments
			: DEFAULT_CODEX_PROVIDER_CONFIG.arguments,
		model: typeof loaded.defaultModel === 'string' ? loaded.defaultModel.trim() : '',
		reasoningEffort: typeof loaded.defaultReasoningEffort === 'string' ? loaded.defaultReasoningEffort.trim() : '',
		useOssModelProvider: typeof loaded.useOssModelProvider === 'boolean'
			? loaded.useOssModelProvider
			: (typeof loaded.codexUseOssModelProvider === 'boolean'
				? loaded.codexUseOssModelProvider
				: DEFAULT_CODEX_PROVIDER_CONFIG.useOssModelProvider),
		localProvider: typeof loaded.localProvider === 'string'
			? loaded.localProvider.trim()
			: (typeof loaded.codexLocalProvider === 'string' ? loaded.codexLocalProvider.trim() : ''),
		executionTimeoutSeconds: normalizeTimeoutSeconds(loaded.executionTimeoutSeconds),
		enableMcpServers: typeof loaded.enableMcpServers === 'boolean'
			? loaded.enableMcpServers
			: DEFAULT_CODEX_PROVIDER_CONFIG.enableMcpServers,
	};
}

function enforcePromptCacheLimit(cache: Record<string, PromptCacheEntry>, limit: number): void {
	const entries = Object.entries(cache);
	if (entries.length <= limit) {
		return;
	}

	entries
		.sort((a, b) => {
			const aTime = Date.parse(a[1].cachedAt);
			const bTime = Date.parse(b[1].cachedAt);
			const aScore = Number.isNaN(aTime) ? 0 : aTime;
			const bScore = Number.isNaN(bTime) ? 0 : bTime;
			return bScore - aScore;
		})
		.slice(limit)
		.forEach(([hash]) => {
			delete cache[hash];
		});
}

function pruneBlockPromptCacheIndex(
	blockPromptCacheIndex: Record<string, string>,
	cache: Record<string, PromptCacheEntry>,
): void {
	for (const [blockId, hash] of Object.entries(blockPromptCacheIndex)) {
		if (!cache[hash]) {
			delete blockPromptCacheIndex[blockId];
		}
	}
}

function formatProcessOutputChunk(
	state: ProcessOutputState,
	stream: 'stdout' | 'stderr',
	text: string,
): string {
	if (!text) {
		return '';
	}

	const normalizedText = text.replace(/\r\n/g, '\n');
	let output = '';

	if (state.lastStream !== null && state.lastStream !== stream && !state.atLineStart) {
		output += '\n';
		state.atLineStart = true;
	}

	for (const char of normalizedText) {
		if (state.atLineStart) {
			if (state.lastStream !== stream) {
				output += `[${stream}]\n`;
				state.lastStream = stream;
			}
			state.atLineStart = false;
		}

		output += char;

		if (char === '\n') {
			state.atLineStart = true;
		}
	}

	return output;
}

function trimProcessOutput(output: string): string {
	if (output.length <= MAX_PROCESS_OUTPUT_CHARS) {
		return output;
	}
	const tail = output.slice(-MAX_PROCESS_OUTPUT_CHARS);
	return `[...process output truncated to last ${MAX_PROCESS_OUTPUT_CHARS} chars...]\n${tail}`;
}
