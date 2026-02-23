import { MarkdownRenderChild, Plugin, TFile } from 'obsidian';
import { buildBlockCacheId, buildBlockSourceFingerprint, buildCacheKey } from './agent-block/cache';
import { buildPromptContext } from './agent-block/context';
import type { AgentBlockDependencies } from './agent-block/dependencies';
import { resolveBlockRequest } from './agent-block/directives';
import { buildStandardizedPrompt } from './agent-block/prompt';
import { formatBlockDuration, getErrorMessage, isCancelledErrorMessage, renderAgentResponse } from './agent-block/render';
import {
	appendExecutionLogOutputSafely,
	cacheResponseSafely,
	cancelExecutionLogRunSafely,
	completeExecutionLogSafely,
	reconcileBlockCacheForNoteSafely,
	setBlockPromptCacheKeySafely,
	setExecutionLogInvocationSafely,
	startExecutionLogSafely,
} from './agent-block/safe-dependencies';

const AUTO_RERUN_DEBOUNCE_MS = 350;

export function registerAgentCodeBlockProcessor(plugin: Plugin, dependencies: AgentBlockDependencies): void {
	plugin.registerMarkdownCodeBlockProcessor('agent', async (source, el, ctx) => {
		const blockEl = el.createDiv({ cls: 'agent-block' });
		const headerEl = blockEl.createDiv({ cls: 'agent-block__header' });
		const statusEl = headerEl.createDiv({ cls: 'agent-block__status' });
		const actionsEl = headerEl.createDiv({ cls: 'agent-block__actions' });
		const refreshButtonEl = actionsEl.createEl('button', {
			cls: 'agent-block__refresh',
			text: '↻',
		});
		refreshButtonEl.type = 'button';
		refreshButtonEl.ariaLabel = 'Refresh agent output';
		const outputEl = blockEl.createDiv({ cls: 'agent-block__output' });
		const blockCacheId = await buildBlockCacheId(
			plugin.app,
			source,
			ctx.sourcePath,
			ctx.getSectionInfo?.(el) ?? null,
		);
		const blockSourceFingerprint = buildBlockSourceFingerprint(source);
		let runSequence = 0;
		let activeExecutionLogId: string | null = null;
		let isRunning = false;
		let autoRerunTimeoutId: number | null = null;
		let queuedAutoRerun = false;

		const setActionButtonMode = (mode: 'refresh' | 'stop'): void => {
			if (mode === 'stop') {
				refreshButtonEl.setText('■');
				refreshButtonEl.ariaLabel = 'Stop agent execution';
				refreshButtonEl.addClass('is-stop');
				return;
			}
			refreshButtonEl.setText('↻');
			refreshButtonEl.ariaLabel = 'Refresh agent output';
			refreshButtonEl.removeClass('is-stop');
		};

		const isRunActive = (runId: number): boolean => blockEl.isConnected && runId === runSequence;
		const scheduleAutoRerun = (): void => {
			if (!blockEl.isConnected) {
				return;
			}

			if (isRunning) {
				queuedAutoRerun = true;
				return;
			}

			if (autoRerunTimeoutId !== null) {
				window.clearTimeout(autoRerunTimeoutId);
			}

			autoRerunTimeoutId = window.setTimeout(() => {
				autoRerunTimeoutId = null;
				if (!blockEl.isConnected) {
					return;
				}
				if (isRunning) {
					queuedAutoRerun = true;
					return;
				}
				void runExecution(false);
			}, AUTO_RERUN_DEBOUNCE_MS);
		};

		const runExecution = async (forceRefresh: boolean): Promise<void> => {
			runSequence += 1;
			const runId = runSequence;
			const startedAt = Date.now();
			const timestamp = new Date().toISOString();
			let executionLogId: string | null = null;

			blockEl.removeClass('is-error');
			blockEl.removeClass('is-stale');
			blockEl.addClass('is-loading');
			refreshButtonEl.disabled = false;
			setActionButtonMode('stop');
			isRunning = true;
			activeExecutionLogId = null;

			try {
				await reconcileBlockCacheForNoteSafely(dependencies, ctx.sourcePath);
				const resolvedBlock = resolveBlockRequest(source, dependencies);
				const promptContext = await buildPromptContext(plugin, ctx.sourcePath, resolvedBlock.contextConfig);
				const standardizedPrompt = buildStandardizedPrompt(
					resolvedBlock.prompt,
					promptContext,
					dependencies.getSettings().globalInstructions,
				);
				const cacheKey = buildCacheKey(
					standardizedPrompt,
					resolvedBlock.template,
					resolvedBlock.overrides,
					resolvedBlock.contextConfig,
				);

				statusEl.setText(
					`Running ${resolvedBlock.template.name || resolvedBlock.template.id} (${resolvedBlock.template.provider})...`,
				);
				outputEl.setText(forceRefresh ? 'Refreshing response...' : 'Waiting for response...');

				if (!forceRefresh) {
					const currentPromptCachedResponse = dependencies.getCachedResponse(cacheKey);
					const indexedPromptHash = dependencies.getBlockPromptCacheKey(blockCacheId);
					const indexedCachedResponse = indexedPromptHash
						? dependencies.getCachedResponse(indexedPromptHash)
						: null;

					if (resolvedBlock.cacheMode === 'prefer-cache') {
						if (indexedCachedResponse !== null) {
							if (indexedPromptHash) {
								await setBlockPromptCacheKeySafely(
									dependencies,
									blockCacheId,
									indexedPromptHash,
									blockSourceFingerprint,
								);
							}
							if (!isRunActive(runId)) {
								return;
							}
							const isStalePrompt = indexedPromptHash !== cacheKey;
							blockEl.removeClass('is-loading');
							if (isStalePrompt) {
								blockEl.addClass('is-stale');
								statusEl.setText('Agent result (cached, stale prompt; refresh to update)');
							} else {
								statusEl.setText('Agent result (cached)');
							}
							await renderAgentResponse(plugin, ctx.sourcePath, outputEl, indexedCachedResponse, ctx);
							return;
						}

						if (currentPromptCachedResponse !== null) {
							await setBlockPromptCacheKeySafely(
								dependencies,
								blockCacheId,
								cacheKey,
								blockSourceFingerprint,
							);
							if (!isRunActive(runId)) {
								return;
							}
							blockEl.removeClass('is-loading');
							statusEl.setText('Agent result (cached)');
							await renderAgentResponse(plugin, ctx.sourcePath, outputEl, currentPromptCachedResponse, ctx);
							return;
						}
					} else if (currentPromptCachedResponse !== null) {
						await setBlockPromptCacheKeySafely(
							dependencies,
							blockCacheId,
							cacheKey,
							blockSourceFingerprint,
						);
						if (!isRunActive(runId)) {
							return;
						}
						blockEl.removeClass('is-loading');
						statusEl.setText('Agent result (cached)');
						await renderAgentResponse(plugin, ctx.sourcePath, outputEl, currentPromptCachedResponse, ctx);
						return;
					}
				}

				executionLogId = await startExecutionLogSafely(dependencies, {
					timestamp,
					originNote: ctx.sourcePath,
					agentTemplateId: resolvedBlock.template.id,
					agentTemplateName: resolvedBlock.template.name,
					provider: resolvedBlock.template.provider,
					prompt: standardizedPrompt,
				});
				activeExecutionLogId = executionLogId;

				const response = await dependencies.runAgent({
					template: resolvedBlock.template,
					prompt: standardizedPrompt,
					overrides: resolvedBlock.overrides,
					executionLogId: executionLogId ?? undefined,
					onInvocation: (invocation) => {
						if (!executionLogId) {
							return;
						}
						void setExecutionLogInvocationSafely(dependencies, executionLogId, invocation);
					},
					onOutputChunk: (chunk) => {
						if (!executionLogId) {
							return;
						}
						void appendExecutionLogOutputSafely(dependencies, executionLogId, chunk.stream, chunk.text);
					},
				});

				await cacheResponseSafely(
					dependencies,
					blockCacheId,
					cacheKey,
					response,
					blockSourceFingerprint,
				);
				if (executionLogId) {
					await completeExecutionLogSafely(dependencies, executionLogId, {
						response,
						wasError: false,
						durationMs: Date.now() - startedAt,
					});
				}

				if (!isRunActive(runId)) {
					return;
				}

				const durationMs = Date.now() - startedAt;
				blockEl.removeClass('is-loading');
				statusEl.setText(`Agent result generated in ${formatBlockDuration(durationMs)}`);
				await renderAgentResponse(plugin, ctx.sourcePath, outputEl, response, ctx);
			} catch (error: unknown) {
				const errorMessage = getErrorMessage(error);
				const cancelled = isCancelledErrorMessage(errorMessage);
				if (executionLogId) {
					await completeExecutionLogSafely(dependencies, executionLogId, {
						response: errorMessage,
						wasError: !cancelled,
						durationMs: Date.now() - startedAt,
						status: cancelled ? 'stopped' : 'error',
					});
				}

				if (!isRunActive(runId)) {
					return;
				}

				blockEl.removeClass('is-loading');
				if (cancelled) {
					statusEl.setText('Agent execution stopped');
					outputEl.setText('Execution stopped by user.');
					return;
				}

				blockEl.addClass('is-error');
				statusEl.setText('Agent execution failed');
				outputEl.empty();
				outputEl.createEl('pre', {
					cls: 'agent-block__error',
					text: errorMessage,
				});
			} finally {
				if (isRunActive(runId)) {
					refreshButtonEl.disabled = false;
					setActionButtonMode('refresh');
					isRunning = false;
					activeExecutionLogId = null;
					const shouldAutoRerun = queuedAutoRerun;
					queuedAutoRerun = false;
					if (shouldAutoRerun && blockEl.isConnected) {
						void runExecution(false);
					}
				}
			}
		};

		refreshButtonEl.addEventListener('click', () => {
			if (!isRunning) {
				void runExecution(true);
				return;
			}
			const executionId = activeExecutionLogId;
			if (!executionId) {
				return;
			}
			refreshButtonEl.disabled = true;
			statusEl.setText('Stopping agent execution...');
			void cancelExecutionLogRunSafely(dependencies, executionId);
		});

		const lifecycleChild = new MarkdownRenderChild(blockEl);
		ctx.addChild(lifecycleChild);
		lifecycleChild.registerEvent(plugin.app.vault.on('modify', (file) => {
			if (!(file instanceof TFile) || file.path !== ctx.sourcePath) {
				return;
			}
			scheduleAutoRerun();
		}));
		lifecycleChild.registerEvent(plugin.app.workspace.on('editor-change', (_editor, info) => {
			const file = info.file;
			if (!(file instanceof TFile) || file.path !== ctx.sourcePath) {
				return;
			}
			scheduleAutoRerun();
		}));
		lifecycleChild.register(() => {
			if (autoRerunTimeoutId !== null) {
				window.clearTimeout(autoRerunTimeoutId);
				autoRerunTimeoutId = null;
			}
		});

		void runExecution(false);
	});
}
