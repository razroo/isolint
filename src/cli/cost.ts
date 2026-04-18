/**
 * `isolint cost` — estimate per-turn prompt-token overhead of a harness.
 *
 * Buckets files by load behavior:
 *   - Shared prefix: loaded on every turn (pay always)
 *   - Mode: loaded when that mode runs
 *   - Agent: loaded when the orchestrator dispatches to that agent
 *
 * Uses the same word/token heuristic as `perf-shared-prefix-budget` so
 * numbers in the cost report line up with lint findings.
 */

import { unified } from "unified";
import remarkParse from "remark-parse";
import type { Root } from "mdast";
import { collectHeadings, type HeadingInfo } from "../lint/ast.js";
import {
  AGENT_PATH_RE,
  MODE_PATH_RE,
  SHARED_PREFIX_PATH_RE,
} from "../lint/paths.js";
import type { DiscoveredFile } from "../lint/scanner.js";

export interface SectionCost {
  title: string;
  words: number;
  approx_tokens: number;
}

export interface FileCost {
  path: string;
  words: number;
  approx_tokens: number;
  sections?: SectionCost[];
}

export interface CostReport {
  shared_prefix: FileCost[];
  modes: FileCost[];
  agents: FileCost[];
  shared_prefix_total_tokens: number;
  shared_prefix_total_words: number;
  heaviest_mode: FileCost | null;
  heaviest_agent: FileCost | null;
}

const WORD_RE = /[A-Za-z0-9$_.-]+/g;
const FRONTMATTER_RE = /^(?:\+\+\+\n[\s\S]*?\n\+\+\+\n?|---\n[\s\S]*?\n---\n?)/;

const parser = unified().use(remarkParse);

function stripFrontmatter(source: string): string {
  return source.replace(FRONTMATTER_RE, "");
}

function wordCount(text: string): number {
  return text.match(WORD_RE)?.length ?? 0;
}

function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function fileCost(path: string, source: string, withSections: boolean): FileCost {
  const body = stripFrontmatter(source);
  const cost: FileCost = {
    path,
    words: wordCount(body),
    approx_tokens: approxTokens(body),
  };
  if (withSections) {
    const ast = parser.parse(source) as Root;
    const headings = collectHeadings(ast);
    if (headings.length > 0) {
      cost.sections = sectionCosts(source, headings);
    }
  }
  return cost;
}

function sectionCosts(source: string, headings: HeadingInfo[]): SectionCost[] {
  const out: SectionCost[] = [];
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    const end = headings[i + 1]?.start_offset ?? source.length;
    const body = source.slice(h.end_offset, end);
    out.push({
      title: h.text,
      words: wordCount(body),
      approx_tokens: approxTokens(body),
    });
  }
  return out.sort((a, b) => b.approx_tokens - a.approx_tokens);
}

export function computeCost(
  files: DiscoveredFile[],
  opts: { sections?: boolean } = {},
): CostReport {
  const shared: FileCost[] = [];
  const modes: FileCost[] = [];
  const agents: FileCost[] = [];

  for (const f of files) {
    if (SHARED_PREFIX_PATH_RE.test(f.rel_path)) {
      shared.push(fileCost(f.rel_path, f.source, opts.sections ?? true));
    } else if (AGENT_PATH_RE.test(f.rel_path)) {
      agents.push(fileCost(f.rel_path, f.source, false));
    } else if (MODE_PATH_RE.test(f.rel_path)) {
      modes.push(fileCost(f.rel_path, f.source, false));
    }
  }

  shared.sort((a, b) => b.approx_tokens - a.approx_tokens);
  modes.sort((a, b) => b.approx_tokens - a.approx_tokens);
  agents.sort((a, b) => b.approx_tokens - a.approx_tokens);

  const shared_prefix_total_tokens = shared.reduce((sum, f) => sum + f.approx_tokens, 0);
  const shared_prefix_total_words = shared.reduce((sum, f) => sum + f.words, 0);

  return {
    shared_prefix: shared,
    modes,
    agents,
    shared_prefix_total_tokens,
    shared_prefix_total_words,
    heaviest_mode: modes[0] ?? null,
    heaviest_agent: agents[0] ?? null,
  };
}

function fmtInt(n: number): string {
  return n.toLocaleString("en-US");
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function padLeft(s: string, width: number): string {
  return s.length >= width ? s : " ".repeat(width - s.length) + s;
}

export function formatCost(report: CostReport, opts: { sections?: boolean } = {}): string {
  const lines: string[] = [];
  const withSections = opts.sections ?? true;

  lines.push("Always-loaded harness overhead");
  lines.push("");

  if (report.shared_prefix.length === 0) {
    lines.push("  (no shared-prefix files found)");
  } else {
    for (const f of report.shared_prefix) {
      lines.push(
        `  ${padLeft("~" + fmtInt(f.approx_tokens), 8)} tokens   ${pad(f.path, 38)}  ${padLeft(fmtInt(f.words), 6)} words`,
      );
      if (withSections && f.sections && f.sections.length > 0) {
        const cutoff = Math.max(200, Math.ceil(f.approx_tokens * 0.05));
        for (const s of f.sections) {
          if (s.approx_tokens < cutoff) break;
          lines.push(
            `    ${padLeft("~" + fmtInt(s.approx_tokens), 6)}   § ${pad(truncate(s.title, 60), 60)}  ${padLeft(fmtInt(s.words), 5)}w`,
          );
        }
      }
    }
    lines.push("");
    lines.push(
      `  Total: ~${fmtInt(report.shared_prefix_total_tokens)} tokens / turn  (${report.shared_prefix.length} file${report.shared_prefix.length === 1 ? "" : "s"}, ${fmtInt(report.shared_prefix_total_words)} words)`,
    );
  }

  if (report.modes.length > 0) {
    lines.push("");
    lines.push("Per-mode context (loads when that mode runs)");
    lines.push("");
    for (const f of report.modes) {
      lines.push(
        `  ${padLeft("~" + fmtInt(f.approx_tokens), 8)} tokens   ${pad(f.path, 38)}  ${padLeft(fmtInt(f.words), 6)} words`,
      );
    }
    if (report.heaviest_mode) {
      const worstCaseTokens = report.shared_prefix_total_tokens + report.heaviest_mode.approx_tokens;
      lines.push("");
      lines.push(
        `  Worst case (shared + heaviest mode): ~${fmtInt(worstCaseTokens)} tokens / turn`,
      );
    }
  }

  if (report.agents.length > 0) {
    lines.push("");
    lines.push("Per-agent context (loads on dispatch)");
    lines.push("");
    for (const f of report.agents) {
      lines.push(
        `  ${padLeft("~" + fmtInt(f.approx_tokens), 8)} tokens   ${pad(f.path, 38)}  ${padLeft(fmtInt(f.words), 6)} words`,
      );
    }
  }

  lines.push("");
  lines.push(
    "Token estimates are approximate (chars ÷ 4). Actual cost depends on the provider's tokenizer.",
  );

  return lines.join("\n");
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}
