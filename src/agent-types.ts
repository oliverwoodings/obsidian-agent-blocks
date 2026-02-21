export type AgentProviderId = 'codex' | 'ollama';

export interface AgentOutputChunk {
	stream: 'stdout' | 'stderr';
	text: string;
}

export interface AgentInvocation {
	command: string;
	args: string[];
}

export interface AgentBlockOverrides {
	model?: string | null;
	reasoningEffort?: string | null;
	useOssModelProvider?: boolean | null;
	localProvider?: string | null;
	temperature?: number | null;
	executionTimeoutSeconds?: number | null;
	mcpEnabled?: boolean | null;
	host?: string | null;
	keepAlive?: string | null;
	numPredict?: number | null;
}
