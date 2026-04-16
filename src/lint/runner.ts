import type { ModelProvider } from "../providers/types.js";
import { DEFAULT_CONFIG } from "./config.js";
import { rulesFromPresets } from "./preset.js";
import { computeLineStarts } from "./source.js";
import { applySuppressions } from "./suppressions.js";
import type {
  LintContext,
  LintFinding,
  LintReport,
  ResolvedConfig,
  Rule,
  Severity,
} from "./types.js";

export interface LintInputFile {
  rel_path: string;
  source: string;
}

export interface RunnerOptions {
  /** Override/extend the preset ruleset. */
  rules?: Rule[];
  /** If true, run LLM-tier rules too. Requires model. */
  llm?: boolean;
  /** Provider used for LLM rules. Required when llm=true. */
  model?: ModelProvider;
  /** Override severity threshold for exit-code purposes. */
  fail_on?: Severity;
}

/**
 * Run the configured ruleset against every file. Pure: does not read
 * the filesystem — feed it DiscoveredFile[] from the scanner.
 */
export async function runLint(
  files: LintInputFile[],
  config: ResolvedConfig = DEFAULT_CONFIG,
  opts: RunnerOptions = {},
): Promise<LintReport> {
  const allRules = opts.rules ?? rulesFromPresets(config.extends ?? ["recommended"]);
  const activeRules = selectActiveRules(allRules, config, opts);

  const findings: LintFinding[] = [];
  const sourceByFile = new Map<string, string>();
  for (const f of files) sourceByFile.set(f.rel_path, f.source);

  for (const file of files) {
    const ctx: LintContext = {
      source: file.source,
      file: file.rel_path,
      line_starts: computeLineStarts(file.source),
      config,
    };
    for (const rule of activeRules) {
      const override = config.rules[rule.id];
      if (override === "off") continue;
      const effectiveSeverity = (override as Severity | undefined) ?? rule.severity;
      try {
        const raw = rule.tier === "llm"
          ? rule.checkLLM && opts.model
            ? await rule.checkLLM(ctx, opts.model)
            : []
          : rule.check?.(ctx) ?? [];
        for (const f of raw) {
          findings.push({ ...f, severity: effectiveSeverity });
        }
      } catch {
        // Rules are sandboxed: one bad rule never kills the whole run.
      }
    }
  }

  const filtered = applySuppressions(findings, sourceByFile);

  const errors = filtered.filter((f) => f.severity === "error").length;
  const warnings = filtered.filter((f) => f.severity === "warn").length;
  const infos = filtered.filter((f) => f.severity === "info").length;

  return { files_scanned: files.length, findings: filtered, errors, warnings, infos };
}

function selectActiveRules(
  rules: Rule[],
  config: ResolvedConfig,
  opts: RunnerOptions,
): Rule[] {
  const out: Rule[] = [];
  for (const rule of rules) {
    if (config.rules[rule.id] === "off") continue;
    if (rule.tier === "llm" && !opts.llm) continue;
    out.push(rule);
  }
  return out;
}

export function exitCodeFor(report: LintReport, threshold: Severity = "error"): number {
  if (threshold === "error") return report.errors > 0 ? 1 : 0;
  if (threshold === "warn") return report.errors + report.warnings > 0 ? 1 : 0;
  return report.errors + report.warnings + report.infos > 0 ? 1 : 0;
}
