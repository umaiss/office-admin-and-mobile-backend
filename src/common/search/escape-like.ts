/**
 * Makes a user-typed search term literal.
 *
 * ## Why this is needed
 *
 * Prisma's `contains` filter compiles to `ILIKE '%term%'` and passes the term
 * straight through. That is safe from injection — the value is still a bound
 * parameter — but it is *not* correct, because LIKE assigns meaning to two
 * characters that a person typing into a search box means literally:
 *
 *   `%`  matches any run of characters. Searching for it returns every row.
 *   `_`  matches exactly one character, so `a_c` finds "abc".
 *
 * Postgres treats backslash as LIKE's default escape character, so prefixing
 * each metacharacter with one restores the literal meaning. The backslash is
 * replaced first — the character class below handles all three in a single
 * pass precisely so a `\` cannot escape an escape we just inserted.
 *
 * Applied at every call site that feeds user input into `contains`; searching
 * for "50%" should find the row that says "50%", not the whole table.
 */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (character) => `\\${character}`);
}
