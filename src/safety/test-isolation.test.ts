import os from 'node:os';
import path from 'node:path';

import { xdg } from '../config/xdg.js';
import audit from './audit.js';

describe('test isolation', () => {
  it('never resolves the app folders or the audit log under the real home folder', () => {
    const home = os.homedir();
    for (const dir of [xdg.config, xdg.data, xdg.state, xdg.cache, audit.AUDIT_LOG_PATH]) {
      expect(path.resolve(dir).startsWith(path.join(home, path.sep))).toBe(false);
    }
  });
});
