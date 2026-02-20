import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import process from 'process';
import type { CodexCliToolsSettings } from './settings';

const PROMPT_PLACEHOLDER = '{{prompt}}';

interface InvocationPlan {
	command: string;
	args: string[];
	sendPromptViaStdin: boolean;
}

interface RunPromptOptions {
	model?: string | null;
}

export class CodexCliRunner {
	private readonly runningProcesses = new Set<ChildProcessWithoutNullStreams>();
	private readonly getSettings: () => CodexCliToolsSettings;

	constructor(getSettings: () => CodexCliToolsSettings) {
		this.getSettings = getSettings;
	}

	async runPrompt(prompt: string, options: RunPromptOptions = {}): Promise<string> {
		const promptText = prompt.trim();
		if (!promptText) {
			throw new Error('Prompt is empty. Add content to the codex block or template.');
		}

		const settings = this.getSettings();
		const invocation = buildInvocation(settings, promptText, options.model ?? null);
		return runProcess(invocation, promptText, this.runningProcesses);
	}

	dispose(): void {
		for (const process of this.runningProcesses) {
			process.kill();
		}
		this.runningProcesses.clear();
	}
}

function parseArguments(argumentText: string): string[] {
	return argumentText
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

function buildInvocation(settings: CodexCliToolsSettings, promptText: string, modelOverride: string | null): InvocationPlan {
	const command = settings.codexCommand.trim() || 'codex';
	const rawArgs = parseArguments(settings.codexArguments);
	const selectedModel = normalizeModelName(modelOverride) ?? normalizeModelName(settings.defaultModel);
	const enableMcpServers = settings.enableMcpServers;

	const hasPlaceholder = rawArgs.some((arg) => arg.includes(PROMPT_PLACEHOLDER));
	const argsWithPrompt = rawArgs.map((arg) => arg.split(PROMPT_PLACEHOLDER).join(promptText));
	const argsWithModel = injectModelArgument(argsWithPrompt, selectedModel);
	const args = injectMcpArgument(argsWithModel, enableMcpServers);

	if (hasPlaceholder) {
		return {
			command,
			args,
			sendPromptViaStdin: false,
		};
	}

	if (args.includes('-')) {
		return {
			command,
			args,
			sendPromptViaStdin: true,
		};
	}

	return {
		command,
		args: [...args, promptText],
		sendPromptViaStdin: false,
	};
}

function normalizeModelName(model: string | null | undefined): string | null {
	if (!model) {
		return null;
	}
	const normalized = model.trim();
	return normalized.length > 0 ? normalized : null;
}

function injectModelArgument(args: string[], model: string | null): string[] {
	if (!model || hasModelArgument(args)) {
		return args;
	}

	const argsWithModel = [...args];
	let insertionIndex = 0;
	const firstArg = argsWithModel[0];
	if (firstArg && !firstArg.startsWith('-')) {
		insertionIndex = 1;
	}
	argsWithModel.splice(insertionIndex, 0, '-m', model);
	return argsWithModel;
}

function hasModelArgument(args: string[]): boolean {
	return args.some((arg, index) => (
		arg === '--model'
		|| arg.startsWith('--model=')
		|| (arg === '-m' && index < args.length - 1)
	));
}

function injectMcpArgument(args: string[], enableMcpServers: boolean): string[] {
	if (enableMcpServers) {
		return args;
	}

	const argsWithMcpDisabled = [...args];
	let insertionIndex = 0;
	const firstArg = argsWithMcpDisabled[0];
	if (firstArg && !firstArg.startsWith('-')) {
		insertionIndex = 1;
	}
	argsWithMcpDisabled.splice(insertionIndex, 0, '-c', 'mcp_servers={}');
	return argsWithMcpDisabled;
}

function runProcess(
	invocation: InvocationPlan,
	promptText: string,
	runningProcesses: Set<ChildProcessWithoutNullStreams>,
): Promise<string> {
	const commandCandidates = buildCommandCandidates(invocation.command);
	let candidateIndex = 0;

	return new Promise((resolve, reject) => {
		const tryStart = (): void => {
			const command = commandCandidates[candidateIndex];
			if (!command) {
				reject(new Error('No codex command candidates were available.'));
				return;
			}

			const childProcess = spawn(command, invocation.args, {
				stdio: ['pipe', 'pipe', 'pipe'],
				windowsHide: true,
			});

			runningProcesses.add(childProcess);

			let stdout = '';
			let stderr = '';

			childProcess.stdout.on('data', (chunk: unknown) => {
				stdout += chunkToString(chunk);
			});

			childProcess.stderr.on('data', (chunk: unknown) => {
				stderr += chunkToString(chunk);
			});

			childProcess.on('error', (error: unknown) => {
				runningProcesses.delete(childProcess);
				if (isCommandNotFoundError(error) && candidateIndex + 1 < commandCandidates.length) {
					candidateIndex += 1;
					tryStart();
					return;
				}

				reject(new Error(buildStartFailureMessage(invocation.command, commandCandidates, error)));
			});

			childProcess.on('close', (code) => {
				runningProcesses.delete(childProcess);
				if (code === 0) {
					resolve(stdout.trim());
					return;
				}

				const details = stderr.trim() || stdout.trim() || `Process exited with code ${String(code)}`;
				reject(new Error(details));
			});

			if (invocation.sendPromptViaStdin) {
				childProcess.stdin.write(promptText);
			}
			childProcess.stdin.end();
		};

		tryStart();
	});
}

function buildCommandCandidates(command: string): string[] {
	const trimmedCommand = command.trim();
	if (!trimmedCommand) {
		return ['codex'];
	}

	const candidates = [trimmedCommand];
	if (trimmedCommand !== 'codex') {
		return candidates;
	}

	if (process.platform === 'darwin') {
		candidates.push('/Applications/Codex.app/Contents/Resources/codex');
	}
	candidates.push('/opt/homebrew/bin/codex');
	candidates.push('/usr/local/bin/codex');

	const homePath = process.env.HOME;
	if (homePath) {
		candidates.push(`${homePath}/.local/bin/codex`);
	}

	return [...new Set(candidates)];
}

function isCommandNotFoundError(error: unknown): boolean {
	if (typeof error !== 'object' || error === null) {
		return false;
	}
	return 'code' in error && (error as { code?: unknown }).code === 'ENOENT';
}

function buildStartFailureMessage(requestedCommand: string, triedCommands: string[], error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const isNotFound = isCommandNotFoundError(error);
	if (!isNotFound) {
		return `Failed to start Codex command "${requestedCommand}": ${message}`;
	}

	const tried = triedCommands.map((candidate) => `"${candidate}"`).join(', ');
	return [
		`Failed to start Codex command "${requestedCommand}" (not found).`,
		`Tried: ${tried}.`,
		'Set an absolute binary path in plugin settings under "Codex command".',
	].join(' ');
}

function chunkToString(chunk: unknown): string {
	if (typeof chunk === 'string') {
		return chunk;
	}
	if (chunk instanceof Uint8Array) {
		return new TextDecoder().decode(chunk);
	}
	return String(chunk);
}
