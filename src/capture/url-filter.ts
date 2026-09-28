/**
 * URL ignore-list shared by every capture door (`-i` / `--ignore-url`).
 *
 * Each pattern is tried as a case-insensitive regex; a pattern that is not a
 * valid regex is matched as a literal substring instead, so users can paste a
 * URL fragment without escaping it.
 */
export function compileIgnorePatterns(patterns: string[] = []): RegExp[] {
  return patterns.map((p) => {
    try {
      return new RegExp(p, "i");
    } catch {
      return new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    }
  });
}

export function matchesAnyPattern(url: string, patterns: RegExp[]): boolean {
  return patterns.some((re) => re.test(url));
}
