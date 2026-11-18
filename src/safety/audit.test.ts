import fs from 'node:fs/promises';
import audit from './audit.js';

vi.mock('node:fs/promises');
const mockFs = vi.mocked(fs);

describe('Audit Logger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFs.mkdir.mockResolvedValue(undefined);
    mockFs.appendFile.mockResolvedValue(undefined);
  });

  it('logs an entry with tool, account, and result', async () => {
    await audit.log('send_email', 'personal', { to: ['a@b.com'] }, 'ok');
    expect(mockFs.appendFile).toHaveBeenCalledOnce();
    const logLine = mockFs.appendFile.mock.calls[0][1] as string;
    const entry = JSON.parse(logLine);
    expect(entry.tool).toBe('send_email');
    expect(entry.account).toBe('personal');
    expect(entry.result).toBe('ok');
    expect(entry.params.to).toEqual(['a@b.com']);
  });

  it('redacts password field', async () => {
    await audit.log('send_email', 'x', { password: 'secret123', to: ['a@b.com'] }, 'ok');
    const logLine = mockFs.appendFile.mock.calls[0][1] as string;
    const entry = JSON.parse(logLine);
    expect(entry.params.password).toBe('[REDACTED]');
    expect(entry.params.to).toEqual(['a@b.com']);
  });

  it('redacts body, bodyText, bodyHtml, content_base64', async () => {
    await audit.log(
      'send_email',
      'x',
      {
        body: 'secret body',
        bodyText: 'text',
        bodyHtml: '<p>html</p>',
        content_base64: 'base64data',
        subject: 'visible',
      },
      'ok',
    );
    const logLine = mockFs.appendFile.mock.calls[0][1] as string;
    const entry = JSON.parse(logLine);
    expect(entry.params.body).toBe('[REDACTED]');
    expect(entry.params.bodyText).toBe('[REDACTED]');
    expect(entry.params.bodyHtml).toBe('[REDACTED]');
    expect(entry.params.content_base64).toBe('[REDACTED]');
    expect(entry.params.subject).toBe('visible');
  });

  it('redacts nested sensitive fields', async () => {
    await audit.log('test', 'x', { nested: { password: 'abc', safe: 'ok' } }, 'ok');
    const logLine = mockFs.appendFile.mock.calls[0][1] as string;
    const entry = JSON.parse(logLine);
    expect(entry.params.nested.password).toBe('[REDACTED]');
    expect(entry.params.nested.safe).toBe('ok');
  });

  it('includes error field when provided', async () => {
    await audit.log('send_email', 'x', {}, 'error', 'Connection failed');
    const logLine = mockFs.appendFile.mock.calls[0][1] as string;
    const entry = JSON.parse(logLine);
    expect(entry.result).toBe('error');
    expect(entry.error).toBe('Connection failed');
  });

  it('does not include error field when not provided', async () => {
    await audit.log('send_email', 'x', {}, 'ok');
    const logLine = mockFs.appendFile.mock.calls[0][1] as string;
    const entry = JSON.parse(logLine);
    expect(entry.error).toBeUndefined();
  });

  it('creates directory before writing', async () => {
    await audit.log('test', 'x', {}, 'ok');
    expect(mockFs.mkdir).toHaveBeenCalledBefore(mockFs.appendFile);
  });

  it('creates the folder owner-only and appends with an owner-only mode', async () => {
    await audit.log('send_email', 'a', {}, 'ok');
    expect(mockFs.mkdir).toHaveBeenCalledWith(expect.any(String), {
      recursive: true,
      mode: 0o700,
    });
    expect(mockFs.appendFile.mock.calls[0][2]).toMatchObject({ mode: 0o600 });
    expect(mockFs.chmod).toHaveBeenCalledWith(expect.any(String), 0o600);
  });

  describe('when the log cannot be written', () => {
    let stderr: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    });
    afterEach(() => {
      stderr.mockRestore();
    });

    it('never rejects when the append fails, and warns once for a streak', async () => {
      // A good write first, so a failure left over from an earlier test cannot hide the first warning.
      await audit.log('t', 'a', {}, 'ok');
      stderr.mockClear();
      mockFs.appendFile.mockRejectedValue(new Error('ENOSPC: no space left on device'));
      await expect(audit.log('send_email', 'a', {}, 'ok')).resolves.toBeUndefined();
      await expect(audit.log('send_email', 'a', {}, 'error', 'x')).resolves.toBeUndefined();
      const warnings = stderr.mock.calls.filter((c: unknown[]) => String(c[0]).includes('[audit]'));
      expect(warnings).toHaveLength(1);
      expect(String(warnings[0][0])).toContain('ENOSPC');
    });

    it('never rejects when the folder cannot be created', async () => {
      mockFs.mkdir.mockRejectedValue(new Error('EACCES: permission denied'));
      await expect(audit.log('move_email', 'a', {}, 'ok')).resolves.toBeUndefined();
    });

    it('warns again after a write works and then fails again', async () => {
      mockFs.appendFile.mockRejectedValueOnce(new Error('EIO'));
      await audit.log('t', 'a', {}, 'ok');
      await audit.log('t', 'a', {}, 'ok'); // works, resets the streak
      stderr.mockClear();
      mockFs.appendFile.mockRejectedValueOnce(new Error('EIO again'));
      await audit.log('t', 'a', {}, 'ok');
      expect(
        stderr.mock.calls.filter((c: unknown[]) => String(c[0]).includes('[audit]')),
      ).toHaveLength(1);
    });
  });
});
