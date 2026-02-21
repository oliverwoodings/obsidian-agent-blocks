import { Plugin } from 'obsidian';
import type { AgentBlockOverrides, AgentInvocation, AgentOutputChunk, AgentProviderId } from './agent-types';
import { registerAgentCodeBlockProcessor } from './agent-block';
import { CodexCliProvider } from './providers/codex-provider';
import { OllamaProvider } from './providers/ollama-provider';
import {
	type AgentBlocksSettings,
	type AgentTemplate,
	type CodexAgentProviderConfig,
	type ExecutionLogEntry,
	type PromptCacheEntry,
	type OllamaAgentProviderConfig,
	AgentSettingTab,
	DEFAULT_CODEX_PROVIDER_CONFIG,
	DEFAULT_OLLAMA_PROVIDER_CONFIG,
	DEFAULT_SETTINGS,
	createDefaultCodexAgentTemplate,
	createTemplateId,
} from './settings';

const MAX_EXECUTION_LOG_ENTRIES = 100;
const MAX_PROMPT_CACHE_ENTRIES = 1000;
const MAX_PROCESS_OUTPUT_CHARS = 100_000;
const PROCESS_OUTPUT_SAVE_INTERVAL_MS = 500;

export default class AgentBlocksPlugin extends Plugin {
	settings!: AgentBlocksSettings;
	private readonly codexProvider = new CodexCliProvider();
	private readonly ollamaProvider = new OllamaProvider();
	private readonly lastProcessOutputSaveAtByLogId = new Map<string, number>();

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
			getCachedResponse: (promptHash: string) => this.settings.promptCache[promptHash]?.response ?? null,
			cacheResponse: async (promptHash: string, response: string) => this.saveCachedResponse(promptHash, response),
		});

		this.addSettingTab(new AgentSettingTab(this.app, this));
	}

	onunload(): void {
		this.codexProvider.dispose();
		this.ollamaProvider.dispose?.();
	}

	async loadSettings(): Promise<void> {
		const loaded = await this.loadData() as Record<string, unknown> | null;
		this.settings = migrateAndNormalizeSettings(loaded);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
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
		onInvocation?: (invocation: AgentInvocation) => void;
		onOutputChunk?: (chunk: AgentOutputChunk) => void;
	}): Promise<string> {
		const runRequest = {
			template: request.template,
			prompt: request.prompt,
			overrides: request.overrides,
			onInvocation: request.onInvocation,
			onOutputChunk: request.onOutputChunk,
		};

		if (request.template.provider === 'codex') {
			const result = await this.codexProvider.run(runRequest);
			return result.response;
		}

		const result = await this.ollamaProvider.run(runRequest);
		return result.response;
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
		if (this.settings.executionLog.length > MAX_EXECUTION_LOG_ENTRIES) {
			this.settings.executionLog = this.settings.executionLog.slice(0, MAX_EXECUTION_LOG_ENTRIES);
			const retainedIds = new Set(this.settings.executionLog.map((logEntry) => logEntry.id));
			for (const logId of this.lastProcessOutputSaveAtByLogId.keys()) {
				if (!retainedIds.has(logId)) {
					this.lastProcessOutputSaveAtByLogId.delete(logId);
				}
			}
		}
		await this.saveSettings();
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

		const prefixed = prefixProcessOutput(stream, text);
		existing.processOutput = trimProcessOutput(`${existing.processOutput}${prefixed}`);

		const now = Date.now();
		const lastSavedAt = this.lastProcessOutputSaveAtByLogId.get(id) ?? 0;
		if (now - lastSavedAt < PROCESS_OUTPUT_SAVE_INTERVAL_MS) {
			return;
		}

		this.lastProcessOutputSaveAtByLogId.set(id, now);
		await this.saveSettings();
	}

	private async completeExecutionLog(
		id: string,
		entry: { response: string; wasError: boolean; durationMs: number },
	): Promise<void> {
		const existing = this.settings.executionLog.find((logEntry) => logEntry.id === id);
		if (!existing) {
			return;
		}

		existing.response = entry.response;
		existing.wasError = entry.wasError;
		existing.durationMs = entry.durationMs;
		existing.status = entry.wasError ? 'error' : 'success';
		this.lastProcessOutputSaveAtByLogId.delete(id);
		await this.saveSettings();
	}

	private async saveCachedResponse(promptHash: string, response: string): Promise<void> {
		this.settings.promptCache[promptHash] = {
			response,
			cachedAt: new Date().toISOString(),
		};
		enforcePromptCacheLimit(this.settings.promptCache, MAX_PROMPT_CACHE_ENTRIES);
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

	return {
		globalInstructions: typeof loaded.globalInstructions === 'string' ? loaded.globalInstructions : '',
		agentTemplates: migratedTemplates,
		defaultAgentTemplateId: defaultTemplateId,
		executionLog: normalizedLog,
		promptCache: normalizedCache,
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
			provider,
			providerConfig: normalizeCodexConfig(raw.providerConfig),
		};
	}

	return {
		id,
		name,
		instructions,
		provider,
		providerConfig: normalizeOllamaConfig(raw.providerConfig),
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
	const status = raw.status === 'running' || raw.status === 'success' || raw.status === 'error'
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

function prefixProcessOutput(stream: 'stdout' | 'stderr', text: string): string {
	const streamPrefix = stream === 'stderr' ? '[stderr] ' : '[stdout] ';
	const lines = text.replace(/\r\n/g, '\n').split('\n');
	const prefixedLines = lines
		.filter((line, index) => line.length > 0 || index < lines.length - 1)
		.map((line) => `${streamPrefix}${line}`);
	return prefixedLines.join('\n') + (text.endsWith('\n') ? '\n' : '');
}

function trimProcessOutput(output: string): string {
	if (output.length <= MAX_PROCESS_OUTPUT_CHARS) {
		return output;
	}
	const tail = output.slice(-MAX_PROCESS_OUTPUT_CHARS);
	return `[...process output truncated to last ${MAX_PROCESS_OUTPUT_CHARS} chars...]\n${tail}`;
}
