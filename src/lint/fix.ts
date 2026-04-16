/**
 * Fix engine
 * ----------
 * Two phases:
 *   1. Deterministic fixes: apply any `fix` attached to a finding directly.
 *   2. LLM rewriter: for remaining `llm_fixable` findings, ask a smart
 *      model to rewrite the offending span into small-model-friendly
 *      prose, one span at a time, validated and byte-diffed.
 *
 * Every fix is non-destructive until `writeFiles` is called. The result
 * exposes the final source + a list of applied fixes + per-file diffs.
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ModelProvider } from "../providers/types.js";
import type { LintFinding } from "./types.js";

export interface FixPlanInputFile {
  rel_path: string;
  abs_path?: string;
  source: string;
}

export interface FileFixResult {
  rel_path: string;
  abs_path?: string;
  original: string;
  fixed: string;
  applied: number;
  skipped: number;
  changed: boolean;
}

export interface FixReport {
  files: FileFixResult[];
  applied_total: number;
  skipped_total: number;
}

export interface FixOptions {
  /** If true, also call the LLM for `llm_fixable` findings without a deterministic fix. */
  use_llm?: boolean;
  /** Model for LLM rewrites. Required if use_llm=true. */
  model?: ModelProvider;
  /** Dry run: compute fixes but do not write to disk. */
  dry_run?: boolean;
  /** Repo root for writing files back. */
  cwd?: string;
}

/**
 * Compute fixes across every file. Does not write unless dry_run === false
 * AND writeFiles is invoked. Callers usually want:
 *   const result = await computeFixes(...);
 *   await writeFiles(result, cwd);
 */
export async function computeFixes(
  files: FixPlanInputFile[],
  findings: LintFinding[],
  opts: FixOptions = {},
): Promise<FixReport> {
  const byFile = new Map<string, LintFinding[]>();
  for (const f of findings) {
    const list = byFile.get(f.file) ?? [];
    list.push(f);
    byFile.set(f.file, list);
  }

  const results: FileFixResult[] = [];
  let appliedTotal = 0;
  let skippedTotal = 0;

  for (const file of files) {
    const fileFindings = byFile.get(file.rel_path) ?? [];
    if (fileFindings.length === 0) {
      results.push({
        rel_path: file.rel_path,
        abs_path: file.abs_path,
        original: file.source,
        fixed: file.source,
        applied: 0,
        skipped: 0,
        changed: false,
      });
      continue;
    }

    const { fixed, applied, skipped } = await applyFixesForFile(
      file.source,
      fileFindings,
      opts,
    );
    appliedTotal += applied;
    skippedTotal += skipped;

    results.push({
      rel_path: file.rel_path,
      abs_path: file.abs_path,
      original: file.source,
      fixed,
      applied,
      skipped,
      changed: fixed !== file.source,
    });
  }

  return { files: results, applied_total: appliedTotal, skipped_total: skippedTotal };
}

/**
 * Apply fixes to a single file. Fixes are applied from end to start of
 * the source so earlier offsets remain valid. Overlapping fixes are
 * resolved by keeping the first one encountered (in reverse-offset order).
 */
async function applyFixesForFile(
  source: string,
  findings: LintFinding[],
  opts: FixOptions,
): Promise<{ fixed: string; applied: number; skipped: number }> {
  const deterministic = findings.filter((f) => f.fix);
  const llmCandidates = findings.filter(
    (f) => !f.fix && f.llm_fixable && opts.use_llm && opts.model,
  );

  const llmFixes: Array<{ finding: LintFinding; replacement: string }> = [];
  for (const finding of llmCandidates) {
    const rewrite = await rewriteWithLLM(source, finding, opts.model!);
    if (rewrite !== null) {
      llmFixes.push({ finding, replacement: rewrite });
    }
  }

  type Edit = { start: number; end: number; replacement: string };
  const edits: Edit[] = [];

  for (const f of deterministic) {
    const fix = f.fix!;
    edits.push({ start: fix.start, end: fix.end, replacement: fix.replacement });
  }

  for (const { finding, replacement } of llmFixes) {
    const found = locateSnippet(source, finding);
    if (!found) continue;
    edits.push({ start: found.start, end: found.end, replacement });
  }

  edits.sort((a, b) => b.start - a.start);

  let fixed = source;
  let applied = 0;
  let skipped = 0;
  let prevStart = source.length + 1;
  for (const edit of edits) {
    if (edit.end > prevStart) {
      skipped++;
      continue;
    }
    fixed = fixed.slice(0, edit.start) + edit.replacement + fixed.slice(edit.end);
    prevStart = edit.start;
    applied++;
  }

  return { fixed, applied, skipped: findings.length - applied - skipped < 0 ? skipped : skipped };
}

function locateSnippet(
  source: string,
  finding: LintFinding,
): { start: number; end: number } | null {
  const lineStarts: number[] = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\n") lineStarts.push(i + 1);
  }
  const startLine = Math.max(1, finding.range.line);
  const endLine = Math.max(startLine, finding.range.end_line ?? startLine);
  const segStart = lineStarts[startLine - 1] ?? 0;
  const segEnd = (lineStarts[endLine] ?? source.length) - 1;
  const segment = source.slice(segStart, segEnd);
  const idx = segment.indexOf(finding.snippet);
  if (idx === -1) return null;
  return { start: segStart + idx, end: segStart + idx + finding.snippet.length };
}

const REWRITE_SYSTEM_PROMPT =
  "You rewrite prose to be executable by weak 7B-class language models " +
  "(Minimax 2.5, Nemotron 3, Mistral 7B). Return ONLY the rewritten span — " +
  "no explanations, no code fences, no quotes, no preamble.";

function buildRewritePrompt(
  source: string,
  finding: LintFinding,
): string {
  const lines = source.split("\n");
  const startLine = Math.max(1, finding.range.line);
  const endLine = Math.max(startLine, finding.range.end_line ?? startLine);
  const ctxStart = Math.max(1, startLine - 3);
  const ctxEnd = Math.min(lines.length, endLine + 3);
  const context = lines.slice(ctxStart - 1, ctxEnd).join("\n");

  return [
    `RULE VIOLATED: ${finding.rule_id}`,
    `REASON: ${finding.message}`,
    ``,
    `SURROUNDING CONTEXT (for reference only, do not rewrite):`,
    context,
    ``,
    `SPAN TO REWRITE (rewrite ONLY this exact text):`,
    finding.snippet,
    ``,
    `REQUIREMENTS:`,
    `  1. Preserve the original intent.`,
    `  2. Keep the same markdown formatting (headings, list markers, bold/italic).`,
    `  3. Use concrete values, explicit enums, and imperative verbs.`,
    `  4. Do not introduce new information not implied by the surrounding context.`,
    `  5. Return the rewritten span only — no quotes, no commentary.`,
  ].join("\n");
}

async function rewriteWithLLM(
  source: string,
  finding: LintFinding,
  model: ModelProvider,
): Promise<string | null> {
  try {
    const res = await model.complete({
      messages: [
        { role: "system", content: REWRITE_SYSTEM_PROMPT },
        { role: "user", content: buildRewritePrompt(source, finding) },
      ],
      temperature: 0.1,
      max_tokens: 512,
    });
    const text = stripFences(res.content).trim();
    if (!text) return null;
    if (text === finding.snippet) return null;
    return text;
  } catch {
    return null;
  }
}

function stripFences(s: string): string {
  const m = s.match(/^```(?:\w+)?\s*\n?([\s\S]*?)\n?```\s*$/);
  return m ? m[1] : s;
}

/** Write every changed file back to disk. Idempotent when dry_run=false. */
export function writeFiles(report: FixReport, cwd: string): number {
  let written = 0;
  for (const f of report.files) {
    if (!f.changed) continue;
    const abs = f.abs_path ?? resolve(cwd, f.rel_path);
    writeFileSync(abs, f.fixed, "utf8");
    written++;
  }
  return written;
}
