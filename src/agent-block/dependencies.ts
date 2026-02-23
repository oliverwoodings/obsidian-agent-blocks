import type { AgentBlockOverrides, AgentInvocation, AgentOutputChunk } from '../agent-types';
import type { AgentCacheMode, AgentBlocksSettings, AgentTemplate, AgentTemplateContextConfig } from '../domain/types';

export interface AgentBlockDependencies {
	getSettings: () => AgentBlocksSettings;
	resolveTemplate: (templateId: string | null) => AgentTemplate | null;
	reconcileBlockCacheForNote: (sourcePath: string) => Promise<void>;
	runAgent: (request: {
		template: AgentTemplate;
		prompt: string;
		overrides: AgentBlockOverrides;
		executionLogId?: string;
		onInvocation?: (invocation: AgentInvocation) => void;
		onOutputChunk?: (chunk: AgentOutputChunk) => void;
	}) => Promise<string>;
	startExecutionLog: (entry: {
		timestamp: string;
		originNote: string;
		agentTemplateId: string;
		agentTemplateName: string;
		provider: AgentTemplate['provider'];
		prompt: string;
	}) => Promise<string>;
	setExecutionLogInvocation: (id: string, invocation: AgentInvocation) => Promise<void>;
	appendExecutionLogOutput: (id: string, stream: 'stdout' | 'stderr', text: string) => Promise<void>;
	completeExecutionLog: (
		id: string,
		entry: {
			response: string;
			wasError: boolean;
			durationMs: number;
			status?: 'success' | 'error' | 'stopped';
		},
	) => Promise<void>;
	cancelExecutionLogRun: (id: string) => Promise<boolean>;
	getCachedResponse: (cacheKey: string) => string | null;
	cacheBlockResponse: (
		blockCacheId: string,
		cacheKey: string,
		response: string,
		blockSourceFingerprint: string,
	) => Promise<void>;
	getBlockPromptCacheKey: (blockCacheId: string) => string | null;
	setBlockPromptCacheKey: (blockCacheId: string, promptHash: string, blockSourceFingerprint: string) => Promise<void>;
}

export interface ResolvedBlockRequest {
	template: AgentTemplate;
	prompt: string;
	overrides: AgentBlockOverrides;
	contextConfig: AgentTemplateContextConfig;
	cacheMode: AgentCacheMode;
}
