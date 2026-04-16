import type { LintContext, SourceRange } from "./types.js";

/** Pre-compute line starts for O(log n) offset→line lookup. */
export function computeLineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

export function offsetToLineCol(
  ctx: LintContext,
  offset: number,
): { line: number; column: number } {
  const starts = ctx.line_starts;
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - starts[lo] + 1 };
}

export function rangeFromOffsets(
  ctx: LintContext,
  start: number,
  end: number,
): SourceRange {
  const s = offsetToLineCol(ctx, start);
  const e = offsetToLineCol(ctx, Math.max(end - 1, start));
  return {
    line: s.line,
    column: s.column,
    end_line: e.line,
    end_column: e.column + 1,
  };
}

/**
 * Build the set of character offsets that should be skipped during
 * linting: fenced code blocks, inline code, and HTML comments.
 *
 * Returns a sorted, non-overlapping list of [start, end) intervals.
 */
export function computeSkipIntervals(
  source: string,
  opts: { fenced_code: boolean; inline_code: boolean; html_comments: boolean },
): [number, number][] {
  const intervals: [number, number][] = [];

  if (opts.fenced_code) {
    const fence = /^(```+|~~~+)[^\n]*\n[\s\S]*?^\1\s*$/gm;
    for (const m of source.matchAll(fence)) {
      intervals.push([m.index!, m.index! + m[0].length]);
    }
  }

  if (opts.inline_code) {
    const inline = /`[^`\n]+`/g;
    for (const m of source.matchAll(inline)) {
      intervals.push([m.index!, m.index! + m[0].length]);
    }
  }

  if (opts.html_comments) {
    const comment = /<!--[\s\S]*?-->/g;
    for (const m of source.matchAll(comment)) {
      intervals.push([m.index!, m.index! + m[0].length]);
    }
  }

  intervals.sort((a, b) => a[0] - b[0]);
  // Merge overlaps.
  const merged: [number, number][] = [];
  for (const iv of intervals) {
    const last = merged[merged.length - 1];
    if (last && iv[0] <= last[1]) {
      last[1] = Math.max(last[1], iv[1]);
    } else {
      merged.push([iv[0], iv[1]]);
    }
  }
  return merged;
}

export function isInSkipInterval(
  offset: number,
  intervals: [number, number][],
): boolean {
  let lo = 0;
  let hi = intervals.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [s, e] = intervals[mid];
    if (offset < s) hi = mid - 1;
    else if (offset >= e) lo = mid + 1;
    else return true;
  }
  return false;
}

/**
 * Iterate over regex matches in `source`, skipping any that start inside
 * a skip interval (code blocks, inline code, HTML comments).
 */
export function* scanMatches(
  source: string,
  pattern: RegExp,
  skipIntervals: [number, number][],
): Generator<RegExpMatchArray & { index: number }> {
  const re = new RegExp(
    pattern.source,
    pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g",
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    if (m.index === re.lastIndex) re.lastIndex++;
    if (isInSkipInterval(m.index, skipIntervals)) continue;
    const out = m as unknown as RegExpMatchArray & { index: number };
    out.index = m.index;
    yield out;
  }
}
