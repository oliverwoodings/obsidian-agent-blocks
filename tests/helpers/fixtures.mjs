export function createBaseTemplate(overrides = {}) {
	return {
		id: 'template-1',
		name: 'Template 1',
		provider: 'codex',
		instructions: 'Base instructions',
		cacheMode: 'auto-refresh',
		context: {
			linkedNoteContent: {
				enabled: false,
				maxNotes: 5,
				maxCharsPerNote: 2000,
				filters: {
					includeOutgoingLinks: true,
					includeBacklinks: false,
					requiredFrontmatterField: '',
				},
				sort: {
					field: 'modified-date',
					direction: 'descending',
					frontmatterDateField: '',
				},
			},
		},
		providerConfig: {
			command: 'codex',
			arguments: 'exec\n-',
			model: '',
			reasoningEffort: '',
			useOssModelProvider: false,
			localProvider: '',
			executionTimeoutSeconds: 300,
			enableMcpServers: true,
		},
		...overrides,
	};
}

export function createSettings(overrides = {}) {
	return {
		globalInstructions: '',
		agentTemplates: [createBaseTemplate()],
		defaultAgentTemplateId: 'template-1',
		promptCacheMaxEntries: 1000,
		promptCacheMaxEntriesPerBlock: 5,
		executionLog: [],
		promptCache: {},
		blockPromptCacheIndex: {},
		blockPromptCacheHistory: {},
		blockPromptCacheSourceFingerprintIndex: {},
		...overrides,
	};
}

export function createExecutionLogEntry(id) {
	return {
		id,
		timestamp: new Date().toISOString(),
		originNote: 'note.md',
		agentTemplateId: 'template-1',
		agentTemplateName: 'Template 1',
		provider: 'codex',
		prompt: 'Prompt',
		command: '',
		commandArgs: [],
		response: '',
		processOutput: '',
		wasError: false,
		durationMs: Number.NaN,
		status: 'running',
	};
}
