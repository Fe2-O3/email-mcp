import { lineDiff } from './line-diff.js';

describe('lineDiff', () => {
  it('shows removals before additions', () => {
    expect(lineDiff('keep;\n', 'discard;\n')).toEqual(['- keep;', '+ discard;']);
  });

  it('treats an empty side as all added or all removed', () => {
    expect(lineDiff('', 'a\nb')).toEqual(['+ a', '+ b']);
    expect(lineDiff('a\r\nb\r\n', '')).toEqual(['- a', '- b']);
  });

  it('folds long unchanged runs, keeping two lines of context', () => {
    const before = Array.from({ length: 10 }, (_, i) => `l${i}`).join('\n');
    const after = before.replace('l5', 'L5');
    expect(lineDiff(before, after)).toEqual([
      '  … (3 unchanged lines)',
      '  l3',
      '  l4',
      '- l5',
      '+ L5',
      '  l6',
      '  l7',
      '  … (2 unchanged lines)',
    ]);
  });

  it('reports a whole replacement above the size cap', () => {
    const big = Array.from({ length: 2100 }, (_, i) => `x${i}`).join('\n');
    expect(lineDiff(big, `${big}\ny`)).toEqual([
      '- (all 2100 old lines)',
      '+ (all 2101 new lines)',
    ]);
  });
});
