import type { PromptCacheEntry } from '../domain/types';

export function enforcePromptCacheLimit(cache: Record<string, PromptCacheEntry>, limit: number): void {
	const entries = Object.entries(cache);
	if (entries.length <= limit) {
		return;
	}

	entries
		.sort((a, b) => {
			const aTime = Date.parse(a[1].cachedAt);
			const bTime = Date.parse(b[1].cachedAt);
			const aScore = Number.isNaN(aTime) ? 0 : aTime;
			const bScore = Number.isNaN(bTime) ? 0 : bTime;
			return bScore - aScore;
		})
		.slice(limit)
		.forEach(([hash]) => {
			delete cache[hash];
		});
}

export function pruneBlockPromptCacheIndex(
	blockPromptCacheIndex: Record<string, string>,
	cache: Record<string, PromptCacheEntry>,
): void {
	for (const [blockId, hash] of Object.entries(blockPromptCacheIndex)) {
		if (!cache[hash]) {
			delete blockPromptCacheIndex[blockId];
		}
	}
}
