import { Plugin, TAbstractFile, TFile } from 'obsidian';
import { registerAgentCodeBlockProcessor } from './agent-block';
import { listAgentBlocksInFile, parseBlockCacheId } from './agent-block/cache';
import { AgentRunner, type AgentExecutionRequest } from './core/agent-runner';
import { ExecutionLogService } from './core/execution-log-service';
import {
	enforcePerBlockPromptCacheLimit,
	enforcePromptCacheLimit,
	isPromptHashReferencedByAnyBlock,
	pruneBlockPromptCacheHistory,
	pruneBlockPromptCacheIndex,
	reconcileBlockCacheEntriesForSourcePath,
	syncBlockPromptCacheIndexFromHistory,
} from './core/prompt-cache';
import { normalizeLoadedSettings } from './core/settings-normalization';
import { normalizePromptCacheMaxEntries, normalizePromptCacheMaxEntriesPerBlock } from './domain/normalizers';
import type { AgentBlocksSettings, AgentTemplate } from './domain/types';
import { CodexCliProvider } from './providers/codex-provider';
import { OllamaProvider } from './providers/ollama-provider';
import { AgentSettingTab } from './settings';

export default class AgentBlocksPlugin extends Plugin {
	settings!: AgentBlocksSettings;
	private readonly runner = new AgentRunner(new CodexCliProvider(), new OllamaProvider());
	private readonly pendingOrphanGcSourcePaths = new Set<string>();
	private executionLogService: ExecutionLogService | null = null;
	private orphanGcTimeoutId: number | null = null;
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
			reconcileBlockCacheForNote: async (sourcePath) => this.reconcileBlockCacheForNote(sourcePath),
			runAgent: (request) => this.runAgent(request),
			startExecutionLog: async (entry) => this.requireExecutionLogService().start(entry),
			setExecutionLogInvocation: async (id, invocation) => this.requireExecutionLogService().setInvocation(id, invocation),
			appendExecutionLogOutput: async (id, stream, text) => this.requireExecutionLogService().appendOutput(id, stream, text),
			completeExecutionLog: async (id, entry) => this.requireExecutionLogService().complete(id, entry),
			cancelExecutionLogRun: async (id) => this.cancelExecutionLogRun(id),
			getCachedResponse: (promptHash: string) => this.settings.promptCache[promptHash]?.response ?? null,
			cacheBlockResponse: async (blockCacheId, promptHash, response, blockSourceFingerprint) =>
				this.saveBlockCachedResponse(blockCacheId, promptHash, response, blockSourceFingerprint),
			getBlockPromptCacheKey: (blockCacheId: string) => this.getBlockPromptCacheKey(blockCacheId),
			setBlockPromptCacheKey: async (blockCacheId: string, promptHash: string, blockSourceFingerprint: string) =>
				this.setBlockPromptCacheKey(blockCacheId, promptHash, blockSourceFingerprint),
			});

		this.registerOrphanGcListeners();
		void this.garbageCollectOrphanedBlockCacheEntries().catch((error: unknown) => {
			console.error('[Agent Blocks] Initial cache reconciliation failed.', error);
		});

		this.settingTab = new AgentSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);
	}

	onunload(): void {
		this.runner.dispose();
		this.executionLogService?.dispose();
		this.executionLogService = null;
		if (this.orphanGcTimeoutId !== null) {
			window.clearTimeout(this.orphanGcTimeoutId);
			this.orphanGcTimeoutId = null;
		}
		this.pendingOrphanGcSourcePaths.clear();
		this.settingTab = null;
	}

	async loadSettings(): Promise<void> {
		const loaded = await this.loadData() as Record<string, unknown> | null;
		this.settings = normalizeLoadedSettings(loaded);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	async applyPromptCacheLimit(): Promise<void> {
		this.settings.promptCacheMaxEntries = normalizePromptCacheMaxEntries(this.settings.promptCacheMaxEntries);
		this.settings.promptCacheMaxEntriesPerBlock = normalizePromptCacheMaxEntriesPerBlock(this.settings.promptCacheMaxEntriesPerBlock);
		this.finalizePromptCacheState();
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

	private async reconcileBlockCacheForNote(sourcePath: string): Promise<void> {
		const changed = await this.reconcileBlockCacheForSourcePath(sourcePath);
		if (!changed) {
			return;
		}
		this.finalizePromptCacheState();
		await this.saveSettings();
	}

	private async saveBlockCachedResponse(
		blockCacheId: string,
		promptHash: string,
		response: string,
		blockSourceFingerprint: string,
	): Promise<void> {
		const normalizedBlockId = blockCacheId.trim();
		const normalizedPromptHash = promptHash.trim();
		if (!normalizedBlockId || !normalizedPromptHash) {
			return;
		}

		const parsedBlockId = parseBlockCacheId(normalizedBlockId);
		if (parsedBlockId) {
			await this.reconcileBlockCacheForSourcePath(parsedBlockId.sourcePath);
		}

		this.settings.promptCache[normalizedPromptHash] = {
			response,
			cachedAt: new Date().toISOString(),
		};
		const currentHistory = this.settings.blockPromptCacheHistory[normalizedBlockId] ?? [];
		const dedupedHistory = [
			normalizedPromptHash,
			...currentHistory.filter((hash) => hash !== normalizedPromptHash),
		];
		this.settings.blockPromptCacheHistory[normalizedBlockId] = dedupedHistory;
		this.settings.blockPromptCacheSourceFingerprintIndex[normalizedBlockId] = blockSourceFingerprint.trim();
		this.finalizePromptCacheState();
		await this.saveSettings();
	}

	private getBlockPromptCacheKey(blockCacheId: string): string | null {
		if (!blockCacheId) {
			return null;
		}
		const hash = this.settings.blockPromptCacheIndex[blockCacheId];
		return typeof hash === 'string' && hash.trim() ? hash : null;
	}

	private async setBlockPromptCacheKey(
		blockCacheId: string,
		promptHash: string,
		blockSourceFingerprint: string,
	): Promise<void> {
		const normalizedBlockId = blockCacheId.trim();
		if (!normalizedBlockId) {
			return;
		}

		const normalizedPromptHash = promptHash.trim();
		if (!normalizedPromptHash) {
			delete this.settings.blockPromptCacheIndex[normalizedBlockId];
			delete this.settings.blockPromptCacheHistory[normalizedBlockId];
			delete this.settings.blockPromptCacheSourceFingerprintIndex[normalizedBlockId];
			this.finalizePromptCacheState();
			await this.saveSettings();
			return;
		}

		this.settings.blockPromptCacheIndex[normalizedBlockId] = normalizedPromptHash;
		const existingHistory = this.settings.blockPromptCacheHistory[normalizedBlockId] ?? [];
		this.settings.blockPromptCacheHistory[normalizedBlockId] = [
			normalizedPromptHash,
			...existingHistory.filter((hash) => hash !== normalizedPromptHash),
		];
		this.settings.blockPromptCacheSourceFingerprintIndex[normalizedBlockId] = blockSourceFingerprint.trim();
		this.finalizePromptCacheState();
		await this.saveSettings();
	}

	private registerOrphanGcListeners(): void {
		this.registerEvent(this.app.vault.on('modify', (file) => {
			this.scheduleOrphanGcForFile(file);
		}));
		this.registerEvent(this.app.vault.on('delete', (file) => {
			this.scheduleOrphanGcForFile(file);
		}));
		this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
			this.scheduleOrphanGcForPath(oldPath);
			this.scheduleOrphanGcForFile(file);
		}));
	}

	private scheduleOrphanGcForFile(file: TAbstractFile): void {
		if (!(file instanceof TFile)) {
			return;
		}
		this.scheduleOrphanGcForPath(file.path);
	}

	private scheduleOrphanGcForPath(sourcePath: string): void {
		if (!sourcePath.toLowerCase().endsWith('.md')) {
			return;
		}
		this.pendingOrphanGcSourcePaths.add(sourcePath);
		if (this.orphanGcTimeoutId !== null) {
			return;
		}
		this.orphanGcTimeoutId = window.setTimeout(() => {
			this.orphanGcTimeoutId = null;
			void this.flushScheduledOrphanGc();
		}, 600);
	}

	private async flushScheduledOrphanGc(): Promise<void> {
		if (this.pendingOrphanGcSourcePaths.size === 0) {
			return;
		}

		const sourcePaths = [...this.pendingOrphanGcSourcePaths];
		this.pendingOrphanGcSourcePaths.clear();
		let changed = false;
		for (const sourcePath of sourcePaths) {
			changed = (await this.reconcileBlockCacheForSourcePath(sourcePath)) || changed;
		}

		if (!changed) {
			return;
		}
		this.finalizePromptCacheState();
		await this.saveSettings();
	}

	private async garbageCollectOrphanedBlockCacheEntries(): Promise<void> {
		let changed = false;
		const sourcePaths = new Set<string>();
		for (const blockId of this.getAllKnownBlockCacheIds()) {
			const parsed = parseBlockCacheId(blockId);
			if (!parsed) {
				changed = this.removeBlockCacheEntry(blockId) || changed;
				continue;
			}
			sourcePaths.add(parsed.sourcePath);
		}

		for (const sourcePath of sourcePaths) {
			changed = (await this.reconcileBlockCacheForSourcePath(sourcePath)) || changed;
		}

		if (!changed) {
			return;
		}
		this.finalizePromptCacheState();
		await this.saveSettings();
	}

	private async reconcileBlockCacheForSourcePath(sourcePath: string): Promise<boolean> {
		if (!sourcePath || !sourcePath.toLowerCase().endsWith('.md')) {
			return false;
		}

		const sourceBlockIds = this.getSourceBlockCacheIds(sourcePath);
		const currentBlocks = (await listAgentBlocksInFile(this.app, sourcePath))
			.map((block) => ({
				blockId: block.blockId,
				sourceFingerprint: block.sourceFingerprint,
			}));

		return reconcileBlockCacheEntriesForSourcePath({
			sourceBlockIds,
			currentBlocks,
			blockPromptCacheHistory: this.settings.blockPromptCacheHistory,
			blockPromptCacheIndex: this.settings.blockPromptCacheIndex,
			blockPromptCacheSourceFingerprintIndex: this.settings.blockPromptCacheSourceFingerprintIndex,
		});
	}

	private getAllKnownBlockCacheIds(): string[] {
		return [...new Set([
			...Object.keys(this.settings.blockPromptCacheHistory),
			...Object.keys(this.settings.blockPromptCacheIndex),
			...Object.keys(this.settings.blockPromptCacheSourceFingerprintIndex),
		])];
	}

	private getSourceBlockCacheIds(sourcePath: string): string[] {
		return this.getAllKnownBlockCacheIds().filter((blockId) => {
			const parsed = parseBlockCacheId(blockId);
			return parsed?.sourcePath === sourcePath;
		});
	}

	private removeBlockCacheEntry(blockId: string): boolean {
		let changed = false;
		const history = this.settings.blockPromptCacheHistory[blockId];
		if (history) {
			delete this.settings.blockPromptCacheHistory[blockId];
			changed = true;
			for (const hash of history) {
				if (isPromptHashReferencedByAnyBlock(hash, this.settings.blockPromptCacheHistory)) {
					continue;
				}
				delete this.settings.promptCache[hash];
			}
		}

		if (this.settings.blockPromptCacheIndex[blockId]) {
			delete this.settings.blockPromptCacheIndex[blockId];
			changed = true;
		}
		if (this.settings.blockPromptCacheSourceFingerprintIndex[blockId]) {
			delete this.settings.blockPromptCacheSourceFingerprintIndex[blockId];
			changed = true;
		}

		return changed;
	}

	private finalizePromptCacheState(): void {
		const removedForBlock = enforcePerBlockPromptCacheLimit(
			this.settings.blockPromptCacheHistory,
			this.settings.promptCacheMaxEntriesPerBlock,
		);
		for (const removedHash of removedForBlock) {
			if (isPromptHashReferencedByAnyBlock(removedHash, this.settings.blockPromptCacheHistory)) {
				continue;
			}
			delete this.settings.promptCache[removedHash];
		}

		const referencedHashes = new Set(Object.values(this.settings.blockPromptCacheHistory).flat());
		for (const hash of Object.keys(this.settings.promptCache)) {
			if (!referencedHashes.has(hash)) {
				delete this.settings.promptCache[hash];
			}
		}

		syncBlockPromptCacheIndexFromHistory(this.settings.blockPromptCacheIndex, this.settings.blockPromptCacheHistory);
		enforcePromptCacheLimit(this.settings.promptCache, this.settings.promptCacheMaxEntries);
		pruneBlockPromptCacheIndex(this.settings.blockPromptCacheIndex, this.settings.promptCache);
		pruneBlockPromptCacheHistory(this.settings.blockPromptCacheHistory, this.settings.promptCache);
		syncBlockPromptCacheIndexFromHistory(this.settings.blockPromptCacheIndex, this.settings.blockPromptCacheHistory);
		for (const blockId of Object.keys(this.settings.blockPromptCacheSourceFingerprintIndex)) {
			if (this.settings.blockPromptCacheHistory[blockId]) {
				continue;
			}
			delete this.settings.blockPromptCacheSourceFingerprintIndex[blockId];
		}
	}

	private requireExecutionLogService(): ExecutionLogService {
		if (!this.executionLogService) {
			throw new Error('Execution log service is not initialized.');
		}
		return this.executionLogService;
	}
}
