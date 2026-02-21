import type { AgentBlockOverrides, AgentInvocation, AgentOutputChunk } from '../agent-types';
import type { AgentTemplate } from '../settings';

export interface AgentRunRequest {
	template: AgentTemplate;
	prompt: string;
	overrides: AgentBlockOverrides;
	onInvocation?: (invocation: AgentInvocation) => void;
	onOutputChunk?: (chunk: AgentOutputChunk) => void;
}

export interface AgentRunResult {
	response: string;
}

export interface AgentProvider {
	run(request: AgentRunRequest): Promise<AgentRunResult>;
	dispose?(): void;
}
