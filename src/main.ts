import { Plugin } from 'obsidian';
import { registerCodexCodeBlockProcessor } from './codex-code-block';
import { CodexCliRunner } from './codex-runner';
import { CodexSettingTab, CodexCliToolsSettings, DEFAULT_SETTINGS, ExecutionLogEntry, PromptCacheEntry } from './settings';

const MAX_EXECUTION_LOG_ENTRIES = 100;
const MAX_PROMPT_CACHE_ENTRIES = 1000;

export default class CodexCliToolsPlugin extends Plugin {
	settings!: CodexCliToolsSettings;
	private codexRunner!: CodexCliRunner;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.codexRunner = new CodexCliRunner(() => this.settings);
		registerCodexCodeBlockProcessor(this, {
			getSettings: () => this.settings,
			runPrompt: (prompt: string, options?: { model?: string | null }) => this.codexRunner.runPrompt(prompt, options),
			logExecution: async (entry) => this.appendExecutionLog(entry),
			getCachedResponse: (promptHash: string) => this.settings.promptCache[promptHash]?.response ?? null,
			cacheResponse: async (promptHash: string, response: string) => this.saveCachedResponse(promptHash, response),
		});

		this.addSettingTab(new CodexSettingTab(this.app, this));
	}

	onunload(): void {
		this.codexRunner?.dispose();
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<CodexCliToolsSettings>);
		if (!Array.isArray(this.settings.promptTemplates)) {
			this.settings.promptTemplates = [];
		}
		if (!Array.isArray(this.settings.executionLog)) {
			this.settings.executionLog = [];
		} else {
			this.settings.executionLog = this.settings.executionLog.map((entry) => ({
				...entry,
				durationMs: typeof entry.durationMs === 'number' ? entry.durationMs : Number.NaN,
			}));
		}
		if (typeof this.settings.defaultModel !== 'string') {
			this.settings.defaultModel = '';
		}
		if (typeof this.settings.enableMcpServers !== 'boolean') {
			this.settings.enableMcpServers = true;
		}
		if (!this.settings.promptCache || typeof this.settings.promptCache !== 'object') {
			this.settings.promptCache = {};
		} else {
			this.settings.promptCache = Object.fromEntries(
				Object.entries(this.settings.promptCache)
					.filter((entry): entry is [string, PromptCacheEntry] => {
						const value = entry[1];
						return typeof value?.response === 'string' && typeof value?.cachedAt === 'string';
					}),
			);
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	private async appendExecutionLog(entry: Omit<ExecutionLogEntry, 'id'>): Promise<void> {
		const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
		this.settings.executionLog.unshift({
			id,
			...entry,
		});
		if (this.settings.executionLog.length > MAX_EXECUTION_LOG_ENTRIES) {
			this.settings.executionLog = this.settings.executionLog.slice(0, MAX_EXECUTION_LOG_ENTRIES);
		}
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
