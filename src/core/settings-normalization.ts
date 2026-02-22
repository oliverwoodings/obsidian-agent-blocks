import {
	DEFAULT_CODEX_PROVIDER_CONFIG,
	DEFAULT_OLLAMA_PROVIDER_CONFIG,
	DEFAULT_SETTINGS,
	DEFAULT_TEMPLATE_CONTEXT_CONFIG,
	createDefaultCodexAgentTemplate,
	createDefaultTemplateContextConfig,
	createTemplateId,
} from '../domain/defaults';
import {
	normalizeAgentCacheMode,
	normalizeLinkedMaxChars,
	normalizeLinkedMaxNotes,
	normalizeLinkedSortDirection,
	normalizeLinkedSortField,
	normalizeNumPredict,
	normalizeOptionalString,
	normalizePromptCacheMaxEntries,
	normalizeTemperature,
	normalizeTimeoutSeconds,
} from '../domain/normalizers';
import type {
	AgentBlocksSettings,
	AgentTemplate,
	AgentTemplateContextConfig,
	CodexAgentProviderConfig,
	ExecutionLogEntry,
	LinkedNoteContentContextConfig,
	OllamaAgentProviderConfig,
	PromptCacheEntry,
} from '../domain/types';
import { enforcePromptCacheLimit } from './prompt-cache';

export function normalizeLoadedSettings(loadedData: Record<string, unknown> | null): AgentBlocksSettings {
	const loaded = loadedData ?? {};
	const normalizedTemplates = normalizeAgentTemplates(loaded.agentTemplates);
	const defaultTemplateId = normalizeDefaultTemplateId(
		loaded.defaultAgentTemplateId,
		normalizedTemplates,
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
		agentTemplates: normalizedTemplates,
		defaultAgentTemplateId: defaultTemplateId,
		promptCacheMaxEntries,
		executionLog: normalizedLog,
		promptCache: normalizedCache,
		blockPromptCacheIndex: normalizedBlockPromptCacheIndex,
	};
}

function normalizeAgentTemplates(value: unknown): AgentTemplate[] {
	if (!Array.isArray(value)) {
		return [createDefaultCodexAgentTemplate(DEFAULT_SETTINGS.defaultAgentTemplateId)];
	}

	const templates: AgentTemplate[] = [];
	for (const candidate of value) {
		const normalized = normalizeAgentTemplate(candidate, templates);
		if (normalized) {
			templates.push(normalized);
		}
	}

	if (templates.length === 0) {
		return [createDefaultCodexAgentTemplate(DEFAULT_SETTINGS.defaultAgentTemplateId)];
	}

	return templates;
}

function normalizeAgentTemplate(value: unknown, existingTemplates: AgentTemplate[]): AgentTemplate | null {
	if (!value || typeof value !== 'object') {
		return null;
	}

	const raw = value as Record<string, unknown>;
	const provider = raw.provider === 'ollama' ? 'ollama' : 'codex';
	const candidateId = typeof raw.id === 'string' ? raw.id.trim() : '';
	const id = candidateId && !existingTemplates.some((template) => template.id === candidateId)
		? candidateId
		: createTemplateId(existingTemplates);
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
				: DEFAULT_TEMPLATE_CONTEXT_CONFIG.linkedNoteContent.filters.includeOutgoingLinks,
			includeBacklinks: typeof rawFilters?.includeBacklinks === 'boolean'
				? rawFilters.includeBacklinks
				: DEFAULT_TEMPLATE_CONTEXT_CONFIG.linkedNoteContent.filters.includeBacklinks,
			requiredFrontmatterField: normalizeOptionalString(rawFilters?.requiredFrontmatterField),
		},
		sort: {
			field: normalizeLinkedSortField(rawSort?.field),
			direction: normalizeLinkedSortDirection(rawSort?.direction),
			frontmatterDateField: normalizeOptionalString(rawSort?.frontmatterDateField),
		},
	};
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
		model: normalizeOptionalString(raw.model),
		reasoningEffort: normalizeOptionalString(raw.reasoningEffort),
		useOssModelProvider: typeof raw.useOssModelProvider === 'boolean'
			? raw.useOssModelProvider
			: DEFAULT_CODEX_PROVIDER_CONFIG.useOssModelProvider,
		localProvider: normalizeOptionalString(raw.localProvider),
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
		host: normalizeOptionalString(raw.host) || DEFAULT_OLLAMA_PROVIDER_CONFIG.host,
		model: normalizeOptionalString(raw.model) || DEFAULT_OLLAMA_PROVIDER_CONFIG.model,
		temperature: normalizeTemperature(raw.temperature),
		numPredict: normalizeNumPredict(raw.numPredict),
		keepAlive: normalizeOptionalString(raw.keepAlive) || DEFAULT_OLLAMA_PROVIDER_CONFIG.keepAlive,
	};
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
	const statusCandidate = raw.status === 'running' || raw.status === 'success' || raw.status === 'error' || raw.status === 'stopped'
		? raw.status
		: (raw.wasError ? 'error' : 'success');
	const status = statusCandidate === 'running' ? 'error' : statusCandidate;

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
		status,
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

	return Object.fromEntries(
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
}
