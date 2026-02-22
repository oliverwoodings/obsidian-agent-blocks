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

export async function cacheResponseSafely(
	dependencies: AgentBlockDependencies,
	cacheKey: string,
	response: string,
): Promise<void> {
	try {
		await dependencies.cacheResponse(cacheKey, response);
	} catch {
		// Cache writes should not break block rendering.
	}
}

export async function setBlockPromptCacheKeySafely(
	dependencies: AgentBlockDependencies,
	blockCacheId: string,
	promptHash: string,
): Promise<void> {
	try {
		await dependencies.setBlockPromptCacheKey(blockCacheId, promptHash);
	} catch {
		// Cache index writes should not break block rendering.
	}
}
