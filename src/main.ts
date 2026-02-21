import { Plugin } from 'obsidian';
import { registerCodexCodeBlockProcessor } from './codex-code-block';
import { CodexCliRunner } from './codex-runner';
import { CodexSettingTab, CodexCliToolsSettings, DEFAULT_SETTINGS, PromptCacheEntry } from './settings';

const MAX_EXECUTION_LOG_ENTRIES = 100;
const MAX_PROMPT_CACHE_ENTRIES = 1000;
const MAX_PROCESS_OUTPUT_CHARS = 100_000;
const PROCESS_OUTPUT_SAVE_INTERVAL_MS = 500;

export default class CodexCliToolsPlugin extends Plugin {
	settings!: CodexCliToolsSettings;
	private codexRunner!: CodexCliRunner;
	private readonly lastProcessOutputSaveAtByLogId = new Map<string, number>();

	async onload(): Promise<void> {
		await this.loadSettings();

		this.codexRunner = new CodexCliRunner(() => this.settings);
		registerCodexCodeBlockProcessor(this, {
			getSettings: () => this.settings,
			runPrompt: (prompt: string, options?: {
				model?: string | null;
				reasoningEffort?: string | null;
				onOutputChunk?: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => void;
			}) => this.codexRunner.runPrompt(prompt, options),
			startExecutionLog: async (entry) => this.startExecutionLog(entry),
			setExecutionLogInvocation: async (id, invocation) => this.setExecutionLogInvocation(id, invocation),
			appendExecutionLogOutput: async (id, stream, text) => this.appendExecutionLogOutput(id, stream, text),
			completeExecutionLog: async (id, entry) => this.completeExecutionLog(id, entry),
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
			this.settings.executionLog = this.settings.executionLog.map((entry) => {
				const hasKnownStatus = entry.status === 'running' || entry.status === 'success' || entry.status === 'error';
				const rawStatus = hasKnownStatus ? entry.status : (entry.wasError ? 'error' : 'success');
				const status = rawStatus === 'running' ? 'error' : rawStatus;
				return {
					id: typeof entry.id === 'string' ? entry.id : `${Date.now()}-${Math.random().toString(16).slice(2)}`,
					timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : new Date().toISOString(),
					originNote: typeof entry.originNote === 'string' ? entry.originNote : '',
					prompt: typeof entry.prompt === 'string' ? entry.prompt : '',
					command: typeof entry.command === 'string' ? entry.command : '',
					commandArgs: Array.isArray(entry.commandArgs)
						? entry.commandArgs.filter((arg): arg is string => typeof arg === 'string')
						: [],
					response: status === 'error'
						? (typeof entry.response === 'string' && entry.response.trim()
							? entry.response
							: 'Run did not complete (Obsidian was reloaded or the process stopped).')
						: (typeof entry.response === 'string' ? entry.response : ''),
					processOutput: typeof entry.processOutput === 'string' ? entry.processOutput : '',
					wasError: status === 'error',
					status,
					durationMs: typeof entry.durationMs === 'number' ? entry.durationMs : Number.NaN,
				};
			});
		}
		if (typeof this.settings.defaultModel !== 'string') {
			this.settings.defaultModel = '';
		}
		if (typeof this.settings.defaultReasoningEffort !== 'string') {
			this.settings.defaultReasoningEffort = '';
		}
		if (typeof this.settings.globalInstructions !== 'string') {
			this.settings.globalInstructions = '';
		}
		this.settings.executionTimeoutSeconds = normalizeTimeoutSeconds(this.settings.executionTimeoutSeconds);
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

	private async startExecutionLog(entry: {
		timestamp: string;
		originNote: string;
		prompt: string;
	}): Promise<string> {
		const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
		this.settings.executionLog.unshift({
			id,
			timestamp: entry.timestamp,
			originNote: entry.originNote,
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
			const retainedIds = new Set(this.settings.executionLog.map((entry) => entry.id));
			for (const logId of this.lastProcessOutputSaveAtByLogId.keys()) {
				if (!retainedIds.has(logId)) {
					this.lastProcessOutputSaveAtByLogId.delete(logId);
				}
			}
		}
		await this.saveSettings();
		return id;
	}

	private async setExecutionLogInvocation(
		id: string,
		invocation: { command: string; args: string[] },
	): Promise<void> {
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

function normalizeTimeoutSeconds(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return 300;
	}
	if (value < 15) {
		return 15;
	}
	if (value > 3600) {
		return 3600;
	}
	return Math.round(value);
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
