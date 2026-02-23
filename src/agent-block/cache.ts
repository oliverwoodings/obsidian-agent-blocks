import { createHash } from 'crypto';
import type { App, TAbstractFile, TFile } from 'obsidian';
import type { AgentBlockOverrides } from '../agent-types';
import type { AgentTemplate, AgentTemplateContextConfig } from '../domain/types';

const BLOCK_CACHE_ID_PREFIX = 'agent-block:';
const BLOCK_CACHE_FALLBACK_PREFIX = `${BLOCK_CACHE_ID_PREFIX}fallback:`;

export interface AgentBlockInFile {
	ordinal: number;
	lineStart: number;
	source: string;
	sourceFingerprint: string;
	blockId: string;
}

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

export async function buildBlockCacheId(
	app: App,
	blockSource: string,
	sourcePath: string,
	sectionInfo: { lineStart: number } | null,
): Promise<string> {
	const blocks = await listAgentBlocksInFile(app, sourcePath);
	const ordinal = resolveAgentBlockOrdinal(blocks, sectionInfo);
	if (sourcePath && ordinal !== null) {
		return formatBlockCacheId(sourcePath, ordinal);
	}

	const payload = JSON.stringify({
		sourcePath,
		blockSourceHash: buildBlockSourceFingerprint(blockSource),
	});
	return `${BLOCK_CACHE_FALLBACK_PREFIX}${createHash('sha256').update(payload).digest('hex')}`;
}

export function buildBlockSourceFingerprint(blockSource: string): string {
	return createHash('sha256').update(blockSource).digest('hex');
}

export function formatBlockCacheId(sourcePath: string, ordinal: number): string {
	return `${BLOCK_CACHE_ID_PREFIX}${encodeURIComponent(sourcePath)}#${ordinal}`;
}

export function parseBlockCacheId(
	blockCacheId: string,
): { sourcePath: string; ordinal: number } | null {
	if (!blockCacheId.startsWith(BLOCK_CACHE_ID_PREFIX) || blockCacheId.startsWith(BLOCK_CACHE_FALLBACK_PREFIX)) {
		return null;
	}

	const payload = blockCacheId.slice(BLOCK_CACHE_ID_PREFIX.length);
	const separatorIndex = payload.lastIndexOf('#');
	if (separatorIndex < 1) {
		return null;
	}

	const encodedPath = payload.slice(0, separatorIndex);
	const ordinalPart = payload.slice(separatorIndex + 1);
	const ordinal = Number.parseInt(ordinalPart, 10);
	if (!Number.isFinite(ordinal) || ordinal < 0) {
		return null;
	}

	try {
		const sourcePath = decodeURIComponent(encodedPath);
		if (!sourcePath) {
			return null;
		}
		return { sourcePath, ordinal };
	} catch {
		return null;
	}
}

export async function countAgentBlocksInFile(app: App, sourcePath: string): Promise<number> {
	const blocks = await listAgentBlocksInFile(app, sourcePath);
	return blocks.length;
}

export async function listAgentBlocksInFile(
	app: App,
	sourcePath: string,
): Promise<AgentBlockInFile[]> {
	if (!sourcePath) {
		return [];
	}

	const content = await readMarkdownFileContent(app, sourcePath);
	if (content === null) {
		return [];
	}

	const blocks = parseAgentBlocksFromContent(content);
	return blocks.map((block, ordinal) => ({
		ordinal,
		lineStart: block.lineStart,
		source: block.source,
		sourceFingerprint: buildBlockSourceFingerprint(block.source),
		blockId: formatBlockCacheId(sourcePath, ordinal),
	}));
}

function resolveAgentBlockOrdinal(
	blocks: AgentBlockInFile[],
	sectionInfo: { lineStart: number } | null,
): number | null {
	if (blocks.length === 0) {
		return null;
	}

	const sectionLineStart = typeof sectionInfo?.lineStart === 'number' ? sectionInfo.lineStart : null;
	if (sectionLineStart === null) {
		return blocks.length === 1 ? 0 : null;
	}

	const lineStarts = blocks.map((block) => block.lineStart);
	const exactIndex = lineStarts.indexOf(sectionLineStart);
	if (exactIndex >= 0) {
		return exactIndex;
	}

	const oneOffCandidates = [sectionLineStart - 1, sectionLineStart + 1];
	for (const candidate of oneOffCandidates) {
		const candidateIndex = lineStarts.indexOf(candidate);
		if (candidateIndex >= 0) {
			return candidateIndex;
		}
	}

	let closestEarlierIndex = -1;
	for (let i = 0; i < lineStarts.length; i += 1) {
		const candidateLineStart = lineStarts[i];
		if (candidateLineStart === undefined) {
			continue;
		}
		if (candidateLineStart <= sectionLineStart) {
			closestEarlierIndex = i;
		} else {
			break;
		}
	}
	return closestEarlierIndex >= 0 ? closestEarlierIndex : 0;
}

async function readMarkdownFileContent(app: App, sourcePath: string): Promise<string | null> {
	const openViewContent = getOpenMarkdownViewContent(app, sourcePath);
	if (openViewContent !== null) {
		return openViewContent;
	}

	const abstractFile = app.vault.getAbstractFileByPath(sourcePath);
	if (!isMarkdownFile(abstractFile)) {
		return null;
	}
	try {
		return await app.vault.cachedRead(abstractFile);
	} catch {
		return null;
	}
}

function getOpenMarkdownViewContent(app: App, sourcePath: string): string | null {
	let content: string | null = null;
	const workspace = (app as { workspace?: unknown }).workspace;
	const iterateAllLeaves = (workspace as { iterateAllLeaves?: unknown } | undefined)?.iterateAllLeaves;
	if (typeof iterateAllLeaves !== 'function') {
		return null;
	}

	(iterateAllLeaves as (callback: (leaf: unknown) => void) => void)((leaf) => {
		if (content !== null) {
			return;
		}
		const view = (leaf as { view?: unknown } | undefined)?.view;
		if (!view || typeof view !== 'object') {
			return;
		}
		const viewFilePath = (view as { file?: { path?: unknown } }).file?.path;
		if (typeof viewFilePath !== 'string' || viewFilePath !== sourcePath) {
			return;
		}
		const getViewData = (view as { getViewData?: unknown }).getViewData;
		if (typeof getViewData !== 'function') {
			return;
		}
		const viewData = (getViewData as () => unknown)();
		if (typeof viewData === 'string') {
			content = viewData;
		}
	});
	return content;
}

function parseAgentBlocksFromContent(content: string): Array<{ lineStart: number; source: string }> {
	const lines = content.split(/\r?\n/u);
	const blocks: Array<{ lineStart: number; source: string }> = [];

	let inFence = false;
	let capturingAgent = false;
	let fenceChar = '';
	let fenceLength = 0;
	let currentBlockStart = -1;
	let currentBlockLines: string[] = [];

	for (const [i, rawLine] of lines.entries()) {
		const line = rawLine ?? '';
		if (!inFence) {
			const match = line.match(/^\s*([`~]{3,})(.*)$/u);
			if (!match) {
				continue;
			}

			const marker = match[1] ?? '';
			const infoString = (match[2] ?? '').trim();
			const language = infoString.split(/\s+/u)[0]?.toLowerCase() ?? '';
			inFence = true;
			capturingAgent = language === 'agent';
			fenceChar = marker.charAt(0);
			fenceLength = marker.length;
			if (capturingAgent) {
				currentBlockStart = i;
				currentBlockLines = [];
			} else {
				currentBlockStart = -1;
				currentBlockLines = [];
			}
			continue;
		}

		const closeRegex = new RegExp(`^\\s*${escapeRegExp(fenceChar)}{${fenceLength},}\\s*$`, 'u');
		if (closeRegex.test(line)) {
			if (capturingAgent && currentBlockStart >= 0) {
				blocks.push({
					lineStart: currentBlockStart,
					source: currentBlockLines.join('\n'),
				});
			}
			inFence = false;
			capturingAgent = false;
			fenceChar = '';
			fenceLength = 0;
			currentBlockStart = -1;
			currentBlockLines = [];
			continue;
		}

		if (capturingAgent) {
			currentBlockLines.push(line);
		}
	}

	return blocks;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function isMarkdownFile(file: TAbstractFile | null): file is TFile {
	return Boolean(
		file
		&& typeof (file as { path?: unknown }).path === 'string'
		&& typeof (file as { basename?: unknown }).basename === 'string'
		&& typeof (file as { stat?: unknown }).stat === 'object'
		&& typeof (file as unknown as { extension?: unknown }).extension === 'string'
		&& (file as unknown as { extension: string }).extension.toLowerCase() === 'md',
	);
}
