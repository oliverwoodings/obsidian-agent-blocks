import type { AgentInvocation } from '../agent-types';
import type { AgentTemplate } from '../domain/types';
import type { AgentBlockDependencies } from './dependencies';

export async function startExecutionLogSafely(
	dependencies: AgentBlockDependencies,
	entry: {
		timestamp: string;
		originNote: string;
		agentTemplateId: string;
		agentTemplateName: string;
		provider: AgentTemplate['provider'];
		prompt: string;
	},
): Promise<string | null> {
	try {
		return await dependencies.startExecutionLog(entry);
	} catch {
		return null;
	}
}

export async function setExecutionLogInvocationSafely(
	dependencies: AgentBlockDependencies,
	id: string,
	invocation: AgentInvocation,
): Promise<void> {
	try {
		await dependencies.setExecutionLogInvocation(id, invocation);
	} catch {
		// Logging should not break block rendering.
	}
}

export async function appendExecutionLogOutputSafely(
	dependencies: AgentBlockDependencies,
	id: string,
	stream: 'stdout' | 'stderr',
	text: string,
): Promise<void> {
	try {
		await dependencies.appendExecutionLogOutput(id, stream, text);
	} catch {
		// Logging should not break block rendering.
	}
}

export async function completeExecutionLogSafely(
	dependencies: AgentBlockDependencies,
	id: string,
	entry: {
		response: string;
		wasError: boolean;
		durationMs: number;
		status?: 'success' | 'error' | 'stopped';
	},
): Promise<void> {
	try {
		await dependencies.completeExecutionLog(id, entry);
	} catch {
		// Logging should not break block rendering.
	}
}

export async function cancelExecutionLogRunSafely(
	dependencies: AgentBlockDependencies,
	id: string,
): Promise<void> {
	try {
		await dependencies.cancelExecutionLogRun(id);
	} catch {
		// Cancellation should not break block rendering.
	}
}

export async function reconcileBlockCacheForNoteSafely(
	dependencies: AgentBlockDependencies,
	sourcePath: string,
): Promise<void> {
	try {
		await dependencies.reconcileBlockCacheForNote(sourcePath);
	} catch {
		// Reconciliation should not break block rendering.
	}
}

export async function cacheResponseSafely(
	dependencies: AgentBlockDependencies,
	blockCacheId: string,
	cacheKey: string,
	response: string,
	blockSourceFingerprint: string,
): Promise<void> {
	try {
		await dependencies.cacheBlockResponse(blockCacheId, cacheKey, response, blockSourceFingerprint);
	} catch {
		// Cache writes should not break block rendering.
	}
}

export async function setBlockPromptCacheKeySafely(
	dependencies: AgentBlockDependencies,
	blockCacheId: string,
	promptHash: string,
	blockSourceFingerprint: string,
): Promise<void> {
	try {
		await dependencies.setBlockPromptCacheKey(blockCacheId, promptHash, blockSourceFingerprint);
	} catch {
		// Cache index writes should not break block rendering.
	}
}
