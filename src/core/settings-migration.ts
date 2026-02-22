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

export function migrateAndNormalizeSettings(loadedData: Record<string, unknown> | null): AgentBlocksSettings {
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
