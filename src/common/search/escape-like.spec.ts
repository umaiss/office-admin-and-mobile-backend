import { escapeLike } from './escape-like';

describe('escapeLike', () => {
  it('leaves an ordinary term untouched', () => {
    expect(escapeLike('printer ink')).toBe('printer ink');
  });

  it('escapes the wildcard that would otherwise match every row', () => {
    expect(escapeLike('%')).toBe('\\%');
    expect(escapeLike('50% off')).toBe('50\\% off');
  });

  it('escapes the single-character wildcard', () => {
    // Without this, searching "a_c" finds "abc".
    expect(escapeLike('a_c')).toBe('a\\_c');
  });

  it('escapes a backslash so it cannot escape our escapes', () => {
    expect(escapeLike('\\')).toBe('\\\\');
    expect(escapeLike('\\%')).toBe('\\\\\\%');
  });

  it('handles a term made entirely of metacharacters', () => {
    expect(escapeLike('%_%')).toBe('\\%\\_\\%');
  });

  it('does not touch quotes — those are the parameter binder concern', () => {
    expect(escapeLike("O'Brien")).toBe("O'Brien");
  });
});
