import type { Plugin } from 'obsidian';
import type { AgentBlocksSettings } from './domain/types';

export interface AgentBlocksPluginApi extends Plugin {
	settings: AgentBlocksSettings;
	saveSettings(): Promise<void>;
	applyPromptCacheLimit(): Promise<void>;
	cancelExecutionLogRun(id: string): Promise<boolean>;
}
