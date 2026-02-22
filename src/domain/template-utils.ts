import type { AgentProviderId } from '../agent-types';
import {
	DEFAULT_CODEX_PROVIDER_CONFIG,
	DEFAULT_OLLAMA_PROVIDER_CONFIG,
	cloneTemplateContext,
	createTemplateId,
} from './defaults';
import type { AgentTemplate } from './types';

export { createTemplateId };

export function convertTemplateProvider(template: AgentTemplate, provider: AgentProviderId): AgentTemplate {
	if (provider === template.provider) {
		return template;
	}

	if (provider === 'codex') {
		return {
			id: template.id,
			name: template.name,
			instructions: template.instructions,
			cacheMode: template.cacheMode,
			context: cloneTemplateContext(template.context),
			provider: 'codex',
			providerConfig: { ...DEFAULT_CODEX_PROVIDER_CONFIG },
		};
	}

	return {
		id: template.id,
		name: template.name,
		instructions: template.instructions,
		cacheMode: template.cacheMode,
		context: cloneTemplateContext(template.context),
		provider: 'ollama',
		providerConfig: { ...DEFAULT_OLLAMA_PROVIDER_CONFIG },
	};
}

export function duplicateTemplate(template: AgentTemplate, templates: AgentTemplate[]): AgentTemplate {
	const id = createDuplicatedTemplateId(templates, template.id);
	const sourceName = template.name.trim() || template.id;
	const name = `Copy of ${sourceName}`;

	if (template.provider === 'codex') {
		return {
			id,
			name,
			instructions: template.instructions,
			cacheMode: template.cacheMode,
			context: cloneTemplateContext(template.context),
			provider: 'codex',
			providerConfig: { ...template.providerConfig },
		};
	}

	return {
		id,
		name,
		instructions: template.instructions,
		cacheMode: template.cacheMode,
		context: cloneTemplateContext(template.context),
		provider: 'ollama',
		providerConfig: { ...template.providerConfig },
	};
}

export function createDuplicatedTemplateId(templates: AgentTemplate[], sourceId: string): string {
	const existingIds = new Set(templates.map((template) => template.id));

	const match = /^(.*?)-(\d+)$/u.exec(sourceId.trim());
	let baseId = sourceId.trim();
	let nextNumber = 2;
	if (match) {
		const parsedNumber = Number.parseInt(match[2] ?? '', 10);
		if (Number.isFinite(parsedNumber)) {
			baseId = (match[1] ?? '').trim() || sourceId.trim();
			nextNumber = parsedNumber + 1;
		}
	}

	if (!baseId) {
		baseId = 'agent';
	}

	let candidate = `${baseId}-${nextNumber}`;
	while (existingIds.has(candidate)) {
		nextNumber += 1;
		candidate = `${baseId}-${nextNumber}`;
	}
	return candidate;
}
