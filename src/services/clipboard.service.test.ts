import { default as ClipboardService, clipboardCommands } from './clipboard.service.js';

describe('clipboardCommands', () => {
  it('uses pbcopy on macOS', () => {
    expect(clipboardCommands('darwin')).toEqual([{ command: 'pbcopy', args: [] }]);
  });

  it('tries common Linux clipboard tools without a shell', () => {
    expect(clipboardCommands('linux').map(({ command }) => command)).toEqual([
      'wl-copy',
      'xclip',
      'xsel',
    ]);
  });

  it('does not claim support on unknown platforms', () => {
    expect(clipboardCommands('freebsd' as NodeJS.Platform)).toEqual([]);
  });
});

describe('ClipboardService', () => {
  it('writes only when explicitly called and pipes the value to stdin', async () => {
    const runner = vi.fn().mockResolvedValue(undefined);
    const clipboard = new ClipboardService('darwin', runner);

    await clipboard.copy('482913');

    expect(runner).toHaveBeenCalledWith('pbcopy', [], '482913');
  });

  it('rejects unsupported platforms and empty values', async () => {
    const clipboard = new ClipboardService('win32');
    await expect(clipboard.copy('482913')).rejects.toThrow(/not supported/);
    await expect(new ClipboardService('darwin').copy('')).rejects.toThrow(/empty/);
  });

  it('limits clipboard writes to ten per minute', async () => {
    const runner = vi.fn().mockResolvedValue(undefined);
    const clipboard = new ClipboardService('darwin', runner);
    for (let i = 0; i < 10; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await clipboard.copy(String(i));
    }

    await expect(clipboard.copy('11')).rejects.toThrow(/rate limit/);
    expect(runner).toHaveBeenCalledTimes(10);
  });
});
