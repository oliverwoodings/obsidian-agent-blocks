import type {
	AgentBlocksSettings,
	AgentTemplate,
	AgentTemplateContextConfig,
	CodexAgentTemplate,
	CodexAgentProviderConfig,
	OllamaAgentTemplate,
	OllamaAgentProviderConfig,
} from './types';

export const DEFAULT_CODEX_PROVIDER_CONFIG: CodexAgentProviderConfig = {
	command: 'codex',
	arguments: ['exec', '--skip-git-repo-check', '--output-last-message', '-'].join('\n'),
	model: '',
	reasoningEffort: '',
	useOssModelProvider: false,
	localProvider: '',
	executionTimeoutSeconds: 300,
	enableMcpServers: true,
};

export const DEFAULT_OLLAMA_PROVIDER_CONFIG: OllamaAgentProviderConfig = {
	host: 'http://127.0.0.1:11434',
	model: 'llama3.2',
	temperature: 0.2,
	numPredict: 512,
	keepAlive: '5m',
};

export const DEFAULT_TEMPLATE_CONTEXT_CONFIG: AgentTemplateContextConfig = {
	linkedNoteContent: {
		enabled: false,
		maxNotes: 5,
		maxCharsPerNote: 2000,
		filters: {
			includeOutgoingLinks: true,
			includeBacklinks: false,
			requiredFrontmatterField: '',
		},
		sort: {
			field: 'modified-date',
			direction: 'descending',
			frontmatterDateField: '',
		},
	},
};

export function createDefaultTemplateContextConfig(): AgentTemplateContextConfig {
	return cloneTemplateContext(DEFAULT_TEMPLATE_CONTEXT_CONFIG);
}

export function createDefaultCodexAgentTemplate(id: string): CodexAgentTemplate {
	return {
		id,
		name: 'Default codex agent',
		provider: 'codex',
		instructions: '',
		cacheMode: 'auto-refresh',
		context: createDefaultTemplateContextConfig(),
		providerConfig: { ...DEFAULT_CODEX_PROVIDER_CONFIG },
	};
}

export function createDefaultOllamaAgentTemplate(id: string): OllamaAgentTemplate {
	return {
		id,
		name: 'Default ollama agent',
		provider: 'ollama',
		instructions: '',
		cacheMode: 'auto-refresh',
		context: createDefaultTemplateContextConfig(),
		providerConfig: { ...DEFAULT_OLLAMA_PROVIDER_CONFIG },
	};
}

export const DEFAULT_SETTINGS: AgentBlocksSettings = {
	globalInstructions: '',
	agentTemplates: [createDefaultCodexAgentTemplate('default-agent')],
	defaultAgentTemplateId: 'default-agent',
	promptCacheMaxEntries: 1000,
	promptCacheMaxEntriesPerBlock: 5,
	executionLog: [],
	promptCache: {},
	blockPromptCacheIndex: {},
	blockPromptCacheHistory: {},
	blockPromptCacheSourceFingerprintIndex: {},
};

export function createTemplateId(templates: AgentTemplate[]): string {
	const existingIds = new Set(templates.map((template) => template.id).filter(Boolean));
	let i = templates.length + 1;
	let candidate = `agent-${i}`;
	while (existingIds.has(candidate)) {
		i += 1;
		candidate = `agent-${i}`;
	}
	return candidate;
}

export function cloneTemplateContext(context: AgentTemplateContextConfig): AgentTemplateContextConfig {
	return {
		linkedNoteContent: {
			enabled: context.linkedNoteContent.enabled,
			maxNotes: context.linkedNoteContent.maxNotes,
			maxCharsPerNote: context.linkedNoteContent.maxCharsPerNote,
			filters: {
				includeOutgoingLinks: context.linkedNoteContent.filters.includeOutgoingLinks,
				includeBacklinks: context.linkedNoteContent.filters.includeBacklinks,
				requiredFrontmatterField: context.linkedNoteContent.filters.requiredFrontmatterField,
			},
			sort: {
				field: context.linkedNoteContent.sort.field,
				direction: context.linkedNoteContent.sort.direction,
				frontmatterDateField: context.linkedNoteContent.sort.frontmatterDateField,
			},
		},
	};
}
