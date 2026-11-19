import './quiet-warnings.js';

// The lifecycle test cannot prove this filter on Node 24+, because those
// versions never print the SQLite notice. These tests feed the notice in by
// hand, so they prove the filter on every Node version.

/** Emit a warning and collect every warning Node actually lets through. */
async function emitted(
  warning: string | Error,
  typeOrOptions?: string | NodeJS.EmitWarningOptions,
): Promise<Error[]> {
  const seen: Error[] = [];
  const onWarning = (w: Error) => seen.push(w);
  process.on('warning', onWarning);
  try {
    if (typeof typeOrOptions === 'string') process.emitWarning(warning, typeOrOptions);
    else process.emitWarning(warning, typeOrOptions);
    // Node fires the 'warning' event on the next tick.
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('warning', onWarning);
  }
  return seen;
}

const SQLITE_NOTICE = 'SQLite is an experimental feature and might change at any time';

describe('quiet-warnings', () => {
  it('drops the SQLite notice when the type is passed as a string (how Node 22 sends it)', async () => {
    expect(await emitted(SQLITE_NOTICE, 'ExperimentalWarning')).toHaveLength(0);
  });

  it('drops the SQLite notice when the type is passed in an options object', async () => {
    expect(await emitted(SQLITE_NOTICE, { type: 'ExperimentalWarning' })).toHaveLength(0);
  });

  it('drops the SQLite notice when it arrives as an Error', async () => {
    const warning = new Error(SQLITE_NOTICE);
    warning.name = 'ExperimentalWarning';
    expect(await emitted(warning)).toHaveLength(0);
  });

  it('still shows other experimental warnings', async () => {
    const seen = await emitted('Fetch is experimental', 'ExperimentalWarning');
    expect(seen.map((w) => w.message)).toEqual(['Fetch is experimental']);
  });

  it('still shows a SQLite warning that is not the experimental notice', async () => {
    const seen = await emitted('SQLite database is locked', 'DeprecationWarning');
    expect(seen.map((w) => w.message)).toEqual(['SQLite database is locked']);
  });
});
