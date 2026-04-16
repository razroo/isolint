/**
 * Isomodel Linter - Core types
 * ----------------------------
 * Lints markdown (and other prose) harness files for patterns that
 * break weak models (Minimax 2.5, Nemotron 3, Mistral 7B, local models).
 *
 * Two tiers:
 *  - Tier 1: deterministic regex / AST checks. Zero cost, runs in CI.
 *  - Tier 2: LLM-assisted checks using Isomodel Plans. Opt-in, costs tokens.
 */

import type { ModelProvider } from "../providers/types.js";

export type Severity = "error" | "warn" | "info";

export type RuleTier = "deterministic" | "llm";

export interface SourceRange {
  /** 1-based line number. */
  line: number;
  /** 1-based column number. */
  column: number;
  /** Inclusive end line. */
  end_line?: number;
  end_column?: number;
}

export interface LintFinding {
  rule_id: string;
  severity: Severity;
  file: string;
  range: SourceRange;
  /** Short, human-actionable message (<=200 chars). */
  message: string;
  /** The exact source snippet that triggered the finding. */
  snippet: string;
  /**
   * Optional deterministic autofix. Present only when the rule can
   * rewrite safely without a model in the loop.
   */
  fix?: Fix;
  /** If true, the finding can be fixed by the LLM rewriter (--fix). */
  llm_fixable?: boolean;
}

export interface Fix {
  /** Character offset (0-based) into the original file. */
  start: number;
  /** Exclusive end offset. */
  end: number;
  /** Replacement text. */
  replacement: string;
  /** Short description of what the fix does. */
  description: string;
}

export interface LintContext {
  /** Full file contents. */
  source: string;
  /** Repo-relative path. */
  file: string;
  /** Line starts (0-based offsets) - provided for cheap line/col math. */
  line_starts: number[];
  /** Resolved config for this file. */
  config: ResolvedConfig;
}

export interface Rule {
  id: string;
  tier: RuleTier;
  severity: Severity;
  /** One-line description. */
  description: string;
  /**
   * Synchronous deterministic check. Required for tier="deterministic".
   * LLM-tier rules leave this undefined and implement `checkLLM`.
   */
  check?: (ctx: LintContext) => LintFinding[];
  /**
   * Async LLM-powered check. Required for tier="llm".
   * Receives a ModelProvider so the rule can run an Isomodel Plan.
   */
  checkLLM?: (ctx: LintContext, model: ModelProvider) => Promise<LintFinding[]>;
}

export interface RulePreset {
  id: string;
  description: string;
  rules: Rule[];
}

export interface ResolvedConfig {
  /** Enabled rule ids. Unknown ids are ignored with a warning. */
  rules: Record<string, Severity | "off">;
  /** Additional glob patterns to ignore on top of built-in defaults. */
  ignore: string[];
  /** Rule-specific options (banned words, max sentence length, etc.). */
  options: Record<string, unknown>;
  /** Extend one or more presets (applied left-to-right before `rules`). */
  extends: string[];
  /**
   * Patterns inside files that should be treated as "code blocks to skip".
   * Defaults to fenced code blocks and inline code spans.
   */
  skip_spans: {
    fenced_code: boolean;
    inline_code: boolean;
    html_comments: boolean;
  };
}

export interface LintReport {
  files_scanned: number;
  findings: LintFinding[];
  errors: number;
  warnings: number;
  infos: number;
}
