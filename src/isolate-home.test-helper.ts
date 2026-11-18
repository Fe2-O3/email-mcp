/**
 * Vitest setup: point every XDG folder at a throwaway directory before any
 * module reads it, so a test can never write to the developer's real
 * ~/.local/share/email-mcp (audit log, local rules), ~/.config/email-mcp or
 * ~/.local/state/email-mcp. A test that wants its own folders still sets
 * its own XDG_* variables before importing the module under test.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = mkdtempSync(path.join(tmpdir(), 'imap-wizard-test-'));
process.env.XDG_DATA_HOME = path.join(root, 'data');
process.env.XDG_STATE_HOME = path.join(root, 'state');
process.env.XDG_CONFIG_HOME = path.join(root, 'config');
process.env.XDG_CACHE_HOME = path.join(root, 'cache');
