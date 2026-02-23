import type { AgentProviderId } from '../agent-types';

export interface ExecutionLogEntry {
	id: string;
	timestamp: string;
	originNote: string;
	agentTemplateId: string;
	agentTemplateName: string;
	provider: AgentProviderId;
	prompt: string;
	command: string;
	commandArgs: string[];
	response: string;
	processOutput: string;
	wasError: boolean;
	durationMs: number;
	status: 'running' | 'success' | 'error' | 'stopped';
}

export interface PromptCacheEntry {
	response: string;
	cachedAt: string;
}

export type AgentCacheMode = 'auto-refresh' | 'prefer-cache';

export interface CodexAgentProviderConfig {
	command: string;
	arguments: string;
	model: string;
	reasoningEffort: string;
	useOssModelProvider: boolean;
	localProvider: string;
	executionTimeoutSeconds: number;
	enableMcpServers: boolean;
}

export interface OllamaAgentProviderConfig {
	host: string;
	model: string;
	temperature: number;
	numPredict: number;
	keepAlive: string;
}

export interface LinkedNoteContentContextConfig {
	enabled: boolean;
	maxNotes: number;
	maxCharsPerNote: number;
	filters: LinkedNoteFiltersConfig;
	sort: LinkedNoteSortConfig;
}

export interface LinkedNoteFiltersConfig {
	includeOutgoingLinks: boolean;
	includeBacklinks: boolean;
	requiredFrontmatterField: string;
}

export interface LinkedNoteSortConfig {
	field: LinkedNoteSortField;
	direction: LinkedNoteSortDirection;
	frontmatterDateField: string;
}

export type LinkedNoteSortField = 'modified-date' | 'created-date' | 'frontmatter-date';
export type LinkedNoteSortDirection = 'descending' | 'ascending';

export interface AgentTemplateContextConfig {
	linkedNoteContent: LinkedNoteContentContextConfig;
}

interface AgentTemplateBase {
	id: string;
	name: string;
	instructions: string;
	cacheMode: AgentCacheMode;
	context: AgentTemplateContextConfig;
}

export interface CodexAgentTemplate extends AgentTemplateBase {
	provider: 'codex';
	providerConfig: CodexAgentProviderConfig;
}

export interface OllamaAgentTemplate extends AgentTemplateBase {
	provider: 'ollama';
	providerConfig: OllamaAgentProviderConfig;
}

export type AgentTemplate = CodexAgentTemplate | OllamaAgentTemplate;

export interface AgentBlocksSettings {
	globalInstructions: string;
	agentTemplates: AgentTemplate[];
	defaultAgentTemplateId: string;
	promptCacheMaxEntries: number;
	promptCacheMaxEntriesPerBlock: number;
	executionLog: ExecutionLogEntry[];
	promptCache: Record<string, PromptCacheEntry>;
	blockPromptCacheIndex: Record<string, string>;
	blockPromptCacheHistory: Record<string, string[]>;
	blockPromptCacheSourceFingerprintIndex: Record<string, string>;
}
