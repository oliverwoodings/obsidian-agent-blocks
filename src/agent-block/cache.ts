import { createHash } from 'crypto';
import type { AgentBlockOverrides } from '../agent-types';
import type { AgentTemplate, AgentTemplateContextConfig } from '../domain/types';

export function buildCacheKey(
	prompt: string,
	template: AgentTemplate,
	overrides: AgentBlockOverrides,
	contextConfig: AgentTemplateContextConfig,
): string {
	const payload = JSON.stringify({
		prompt,
		templateId: template.id,
		provider: template.provider,
		templateConfig: template.providerConfig,
		contextConfig,
		overrides: {
			model: overrides.model ?? null,
			reasoningEffort: overrides.reasoningEffort ?? null,
			useOssModelProvider: overrides.useOssModelProvider ?? null,
			localProvider: overrides.localProvider ?? null,
			temperature: overrides.temperature ?? null,
			executionTimeoutSeconds: overrides.executionTimeoutSeconds ?? null,
			mcpEnabled: overrides.mcpEnabled ?? null,
			host: overrides.host ?? null,
			keepAlive: overrides.keepAlive ?? null,
			numPredict: overrides.numPredict ?? null,
		},
	});
	return createHash('sha256').update(payload).digest('hex');
}

export function buildBlockCacheId(
	blockSource: string,
	sourcePath: string,
	sectionInfo: { lineStart: number } | null,
): string {
	const lineStart = typeof sectionInfo?.lineStart === 'number' ? sectionInfo.lineStart : null;
	const payload = JSON.stringify({
		sourcePath,
		lineStart,
		fallbackSourceHash: lineStart === null
			? createHash('sha256').update(blockSource).digest('hex')
			: null,
	});
	return createHash('sha256').update(payload).digest('hex');
}
