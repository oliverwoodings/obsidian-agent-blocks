const MAX_PROCESS_OUTPUT_CHARS = 100_000;

export interface ProcessOutputState {
	atLineStart: boolean;
	lastStream: 'stdout' | 'stderr' | null;
}

export function formatProcessOutputChunk(
	state: ProcessOutputState,
	stream: 'stdout' | 'stderr',
	text: string,
): string {
	if (!text) {
		return '';
	}

	const normalizedText = text.replace(/\r\n/g, '\n');
	let output = '';

	if (state.lastStream !== null && state.lastStream !== stream && !state.atLineStart) {
		output += '\n';
		state.atLineStart = true;
	}

	for (const char of normalizedText) {
		if (state.atLineStart) {
			if (state.lastStream !== stream) {
				output += `[${stream}]\n`;
				state.lastStream = stream;
			}
			state.atLineStart = false;
		}

		output += char;

		if (char === '\n') {
			state.atLineStart = true;
		}
	}

	return output;
}

export function trimProcessOutput(output: string): string {
	if (output.length <= MAX_PROCESS_OUTPUT_CHARS) {
		return output;
	}
	const tail = output.slice(-MAX_PROCESS_OUTPUT_CHARS);
	return `[...process output truncated to last ${MAX_PROCESS_OUTPUT_CHARS} chars...]\n${tail}`;
}
