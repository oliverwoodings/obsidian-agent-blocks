import { MarkdownRenderChild, MarkdownRenderer, Plugin } from 'obsidian';

export async function renderAgentResponse(
	plugin: Plugin,
	sourcePath: string,
	outputEl: HTMLElement,
	response: string,
	ctx: { addChild: (child: MarkdownRenderChild) => void },
): Promise<void> {
	outputEl.empty();
	if (!response.trim()) {
		outputEl.createEl('p', { text: 'Agent returned an empty response.' });
		return;
	}

	const renderChild = new MarkdownRenderChild(outputEl);
	ctx.addChild(renderChild);
	await MarkdownRenderer.render(plugin.app, response, outputEl, sourcePath, renderChild);
}

export function formatBlockDuration(durationMs: number): string {
	if (durationMs < 1000) {
		return `${durationMs}ms`;
	}
	return `${(durationMs / 1000).toFixed(2)}s`;
}

export function getErrorMessage(error: unknown): string {
	if (error instanceof Error && error.message) {
		return error.message;
	}
	return 'Unknown error while running agent execution.';
}

export function isCancelledErrorMessage(message: string): boolean {
	return message.trim().toLowerCase() === 'agent execution canceled by user.';
}
