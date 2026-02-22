import type { AgentInvocation, AgentProviderId } from '../agent-types';
import type { AgentBlocksSettings } from '../domain/types';
import { formatProcessOutputChunk, type ProcessOutputState, trimProcessOutput } from './process-output';

const MAX_EXECUTION_LOG_ENTRIES = 100;
const PROCESS_OUTPUT_SAVE_INTERVAL_MS = 500;

interface ExecutionLogServiceOptions {
	getSettings: () => AgentBlocksSettings;
	saveSettings: () => Promise<void>;
	notifyExecutionLogUpdated: () => void;
	deleteCancellationByLogId: (id: string) => void;
	pruneCancellationRegistry: (retainedIds: Set<string>) => void;
}

export class ExecutionLogService {
	private readonly lastProcessOutputSaveAtByLogId = new Map<string, number>();
	private readonly processOutputStateByLogId = new Map<string, ProcessOutputState>();

	constructor(private readonly options: ExecutionLogServiceOptions) {}

	async start(entry: {
		timestamp: string;
		originNote: string;
		agentTemplateId: string;
		agentTemplateName: string;
		provider: AgentProviderId;
		prompt: string;
	}): Promise<string> {
		const settings = this.options.getSettings();
		const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
		settings.executionLog.unshift({
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
		if (settings.executionLog.length > MAX_EXECUTION_LOG_ENTRIES) {
			settings.executionLog = settings.executionLog.slice(0, MAX_EXECUTION_LOG_ENTRIES);
			const retainedIds = new Set(settings.executionLog.map((logEntry) => logEntry.id));
			this.pruneTransientState(retainedIds);
			this.options.pruneCancellationRegistry(retainedIds);
		}
		await this.options.saveSettings();
		this.options.notifyExecutionLogUpdated();
		return id;
	}

	async setInvocation(id: string, invocation: AgentInvocation): Promise<void> {
		const settings = this.options.getSettings();
		const existing = settings.executionLog.find((logEntry) => logEntry.id === id);
		if (!existing) {
			return;
		}

		existing.command = invocation.command;
		existing.commandArgs = [...invocation.args];
		await this.options.saveSettings();
		this.options.notifyExecutionLogUpdated();
	}

	async appendOutput(
		id: string,
		stream: 'stdout' | 'stderr',
		text: string,
	): Promise<void> {
		if (!text) {
			return;
		}

		const settings = this.options.getSettings();
		const existing = settings.executionLog.find((logEntry) => logEntry.id === id);
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
			this.options.notifyExecutionLogUpdated();
			return;
		}

		this.lastProcessOutputSaveAtByLogId.set(id, now);
		await this.options.saveSettings();
		this.options.notifyExecutionLogUpdated();
	}

	async complete(
		id: string,
		entry: {
			response: string;
			wasError: boolean;
			durationMs: number;
			status?: 'success' | 'error' | 'stopped';
		},
	): Promise<void> {
		const settings = this.options.getSettings();
		const existing = settings.executionLog.find((logEntry) => logEntry.id === id);
		if (!existing) {
			return;
		}

		existing.response = entry.response;
		existing.durationMs = entry.durationMs;
		existing.status = entry.status ?? (entry.wasError ? 'error' : 'success');
		existing.wasError = existing.status === 'error';
		this.lastProcessOutputSaveAtByLogId.delete(id);
		this.processOutputStateByLogId.delete(id);
		this.options.deleteCancellationByLogId(id);
		await this.options.saveSettings();
		this.options.notifyExecutionLogUpdated();
	}

	dispose(): void {
		this.lastProcessOutputSaveAtByLogId.clear();
		this.processOutputStateByLogId.clear();
	}

	private pruneTransientState(retainedIds: Set<string>): void {
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
	}
}
