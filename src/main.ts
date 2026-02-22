import { Plugin } from 'obsidian';
import { registerAgentCodeBlockProcessor } from './agent-block';
import { AgentRunner, type AgentExecutionRequest } from './core/agent-runner';
import { ExecutionLogService } from './core/execution-log-service';
import { enforcePromptCacheLimit, pruneBlockPromptCacheIndex } from './core/prompt-cache';
import { migrateAndNormalizeSettings } from './core/settings-migration';
import { normalizePromptCacheMaxEntries } from './domain/normalizers';
import type { AgentBlocksSettings, AgentTemplate } from './domain/types';
import { CodexCliProvider } from './providers/codex-provider';
import { OllamaProvider } from './providers/ollama-provider';
import { AgentSettingTab } from './settings';

export default class AgentBlocksPlugin extends Plugin {
	settings!: AgentBlocksSettings;
	private readonly runner = new AgentRunner(new CodexCliProvider(), new OllamaProvider());
	private executionLogService: ExecutionLogService | null = null;
	private settingTab: AgentSettingTab | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.executionLogService = new ExecutionLogService({
			getSettings: () => this.settings,
			saveSettings: () => this.saveSettings(),
			notifyExecutionLogUpdated: () => this.settingTab?.notifyExecutionLogUpdated(),
			deleteCancellationByLogId: (id) => this.runner.deleteCancellation(id),
			pruneCancellationRegistry: (retainedIds) => this.runner.prune(retainedIds),
		});

		registerAgentCodeBlockProcessor(this, {
			getSettings: () => this.settings,
			resolveTemplate: (templateId) => this.resolveTemplate(templateId),
			runAgent: (request) => this.runAgent(request),
			startExecutionLog: async (entry) => this.requireExecutionLogService().start(entry),
			setExecutionLogInvocation: async (id, invocation) => this.requireExecutionLogService().setInvocation(id, invocation),
			appendExecutionLogOutput: async (id, stream, text) => this.requireExecutionLogService().appendOutput(id, stream, text),
			completeExecutionLog: async (id, entry) => this.requireExecutionLogService().complete(id, entry),
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
		this.runner.dispose();
		this.executionLogService?.dispose();
		this.executionLogService = null;
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

	async cancelExecutionLogRun(id: string): Promise<boolean> {
		const cancelled = this.runner.cancel(id);
		if (cancelled) {
			this.settingTab?.notifyExecutionLogUpdated();
		}
		return cancelled;
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

	private async runAgent(request: AgentExecutionRequest): Promise<string> {
		return this.runner.run(request);
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

	private requireExecutionLogService(): ExecutionLogService {
		if (!this.executionLogService) {
			throw new Error('Execution log service is not initialized.');
		}
		return this.executionLogService;
	}
}
