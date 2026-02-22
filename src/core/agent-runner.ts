import type { AgentBlockOverrides, AgentInvocation, AgentOutputChunk } from '../agent-types';
import type { AgentTemplate } from '../domain/types';
import type { CodexCliProvider } from '../providers/codex-provider';
import type { OllamaProvider } from '../providers/ollama-provider';

const USER_CANCELLED_MESSAGE = 'Agent execution canceled by user.';

export interface AgentExecutionRequest {
	template: AgentTemplate;
	prompt: string;
	overrides: AgentBlockOverrides;
	executionLogId?: string;
	onInvocation?: (invocation: AgentInvocation) => void;
	onOutputChunk?: (chunk: AgentOutputChunk) => void;
}

export class AgentRunner {
	private readonly cancelExecutionByLogId = new Map<string, () => void>();

	constructor(
		private readonly codexProvider: CodexCliProvider,
		private readonly ollamaProvider: OllamaProvider,
	) {}

	async run(request: AgentExecutionRequest): Promise<string> {
		const abortController = new AbortController();
		let settled = false;
		let cancelled = false;

		return await new Promise<string>((resolve, reject) => {
			const finishResolve = (value: string): void => {
				if (settled) {
					return;
				}
				settled = true;
				if (request.executionLogId) {
					this.cancelExecutionByLogId.delete(request.executionLogId);
				}
				resolve(value);
			};

			const finishReject = (error: Error): void => {
				if (settled) {
					return;
				}
				settled = true;
				if (request.executionLogId) {
					this.cancelExecutionByLogId.delete(request.executionLogId);
				}
				reject(error);
			};

			const cancel = (): void => {
				if (settled || cancelled) {
					return;
				}
				cancelled = true;
				abortController.abort();
				finishReject(new Error(USER_CANCELLED_MESSAGE));
			};

			if (request.executionLogId) {
				this.cancelExecutionByLogId.set(request.executionLogId, cancel);
			}

			const runRequest = {
				template: request.template,
				prompt: request.prompt,
				overrides: request.overrides,
				abortSignal: abortController.signal,
				onInvocation: (invocation: AgentInvocation) => {
					if (settled || cancelled) {
						return;
					}
					request.onInvocation?.(invocation);
				},
				onOutputChunk: (chunk: AgentOutputChunk) => {
					if (settled || cancelled) {
						return;
					}
					request.onOutputChunk?.(chunk);
				},
			};

			const runPromise = request.template.provider === 'codex'
				? this.codexProvider.run(runRequest)
				: this.ollamaProvider.run(runRequest);

			runPromise
				.then((result) => {
					if (cancelled || abortController.signal.aborted) {
						finishReject(new Error(USER_CANCELLED_MESSAGE));
						return;
					}
					finishResolve(result.response);
				})
				.catch((error: unknown) => {
					if (cancelled || abortController.signal.aborted) {
						finishReject(new Error(USER_CANCELLED_MESSAGE));
						return;
					}

					if (error instanceof Error) {
						finishReject(error);
						return;
					}
					finishReject(new Error(String(error)));
				});
		});
	}

	cancel(id: string): boolean {
		const cancel = this.cancelExecutionByLogId.get(id);
		if (!cancel) {
			return false;
		}
		cancel();
		return true;
	}

	prune(retainedIds: Set<string>): void {
		for (const logId of this.cancelExecutionByLogId.keys()) {
			if (!retainedIds.has(logId)) {
				this.cancelExecutionByLogId.delete(logId);
			}
		}
	}

	dispose(): void {
		this.codexProvider.dispose();
		this.ollamaProvider.dispose?.();
		for (const cancel of this.cancelExecutionByLogId.values()) {
			cancel();
		}
		this.cancelExecutionByLogId.clear();
	}

	deleteCancellation(id: string): void {
		this.cancelExecutionByLogId.delete(id);
	}
}
