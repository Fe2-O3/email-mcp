/**
 * Drop Node's "SQLite is an experimental feature" notice.
 *
 * The local cache uses the built-in `node:sqlite`, and Node prints that
 * notice on every start. MCP clients show stderr as the server log, so the
 * line reads like a problem when it is not one. Every other warning passes
 * through unchanged. This module must be imported before anything that loads
 * `node:sqlite`.
 */

const original = process.emitWarning.bind(process);

process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const message = typeof warning === 'string' ? warning : warning.message;
  const first = rest[0];
  const type =
    typeof first === 'string'
      ? first
      : typeof first === 'object' && first !== null && 'type' in first
        ? String((first as { type?: unknown }).type)
        : warning instanceof Error
          ? warning.name
          : '';
  if (type === 'ExperimentalWarning' && /sqlite/i.test(message)) return;
  (original as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;
