/**
 * Escape SQL LIKE metacharacters (% _ and the escape character itself) in a
 * user-supplied value so it matches literally inside a `%...%` pattern.
 * Every use must pair the bound pattern with `ESCAPE '\'` in the SQL.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
