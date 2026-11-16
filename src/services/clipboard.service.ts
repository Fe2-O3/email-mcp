import { spawn } from 'node:child_process';

interface ClipboardCommand {
  command: string;
  args: string[];
}

export function clipboardCommands(platform: NodeJS.Platform): ClipboardCommand[] {
  if (platform === 'darwin') return [{ command: 'pbcopy', args: [] }];
  if (platform === 'linux') {
    return [
      { command: 'wl-copy', args: [] },
      { command: 'xclip', args: ['-selection', 'clipboard'] },
      { command: 'xsel', args: ['--clipboard', '--input'] },
    ];
  }
  return [];
}

type ClipboardRunner = (command: string, args: string[], value: string) => Promise<void>;
const MAX_WRITES_PER_MINUTE = 10;

async function runClipboardCommand(command: string, args: string[], value: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    } catch (err) {
      reject(err);
      return;
    }
    let settled = false;
    let stderr = '';
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`${command} timed out while writing to clipboard.`));
    }, 5_000);
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 1024) stderr += chunk.toString().slice(0, 1024 - stderr.length);
    });
    child.once('error', (err) => finish(err));
    child.stdin?.once('error', (err) => finish(err));
    child.once('close', (code) => {
      if (code === 0) finish();
      else finish(new Error(stderr.trim() || `${command} exited with code ${code}`));
    });
    child.stdin?.end(value, 'utf8');
  });
}

/** Clipboard writes only. This service never reads or clears the clipboard. */
export default class ClipboardService {
  private writeTimes: number[] = [];

  constructor(
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly runner: ClipboardRunner = runClipboardCommand,
  ) {}

  async copy(value: string): Promise<void> {
    if (!value || value.length > 8192) {
      throw new Error('Clipboard value is empty or too large.');
    }
    const commands = clipboardCommands(this.platform);
    if (commands.length === 0) {
      throw new Error(`Clipboard copy is not supported on ${this.platform}.`);
    }
    const now = Date.now();
    this.writeTimes = this.writeTimes.filter((time) => now - time < 60_000);
    if (this.writeTimes.length >= MAX_WRITES_PER_MINUTE) {
      throw new Error('Clipboard write rate limit exceeded.');
    }
    this.writeTimes.push(now);

    let lastError: unknown;
    for (const { command, args } of commands) {
      try {
        await this.runner(command, args, value);
        return;
      } catch (err) {
        lastError = err;
      }
    }

    throw new Error(
      `Could not write to the clipboard: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
  }
}
