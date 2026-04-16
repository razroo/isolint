/**
 * Tier 1 rules: deterministic, zero-cost, regex-based.
 *
 * Each rule flags a pattern that weak models (Minimax 2.5, Nemotron 3,
 * Mistral 7B, local models) reliably fail on. Rules intentionally err
 * on the side of false positives that are easy to dismiss — missing a
 * failure mode is far more expensive than an extra warning.
 *
 * Every rule skips fenced code blocks, inline code, and HTML comments
 * via the skip intervals built by computeSkipIntervals.
 */

import { sentenceAt, tokenizeSentences } from "../sentences.js";
import { computeSkipIntervals, rangeFromOffsets, scanMatches } from "../source.js";
import type { Fix, LintContext, LintFinding, Rule } from "../types.js";

function findingsFrom(
  ctx: LintContext,
  rule: { id: string; severity: "error" | "warn" | "info" },
  matches: Array<{ start: number; end: number; message: string; fix?: Fix; llm_fixable?: boolean }>,
): LintFinding[] {
  return matches.map(({ start, end, message, fix, llm_fixable }) => ({
    rule_id: rule.id,
    severity: rule.severity,
    file: ctx.file,
    range: rangeFromOffsets(ctx, start, end),
    message,
    snippet: ctx.source.slice(start, end),
    ...(fix ? { fix } : {}),
    ...(llm_fixable ? { llm_fixable: true } : {}),
  }));
}

function skip(ctx: LintContext) {
  return computeSkipIntervals(ctx.source, ctx.config.skip_spans);
}

/** ---- Rule: soft-imperative ------------------------------------------ */

export const softImperative: Rule = {
  id: "soft-imperative",
  tier: "deterministic",
  severity: "warn",
  description: "Use MUST / ALWAYS / NEVER instead of should / might / could / consider.",
  check(ctx) {
    const words = ["should", "could", "might", "may want to", "consider", "perhaps", "probably", "ideally", "preferably"];
    const re = new RegExp(`\\b(${words.join("|")})\\b`, "gi");
    const skips = skip(ctx);
    const sentences = tokenizeSentences(ctx.source, skips);
    const matches: Array<{ start: number; end: number; message: string; llm_fixable?: boolean }> = [];
    for (const m of scanMatches(ctx.source, re, skips)) {
      const containing = sentenceAt(sentences, m.index);
      // Skip interrogative sentences — "What story should they tell?" isn't an instruction.
      if (containing && containing.text.endsWith("?")) continue;
      matches.push({
        start: m.index,
        end: m.index + m[0].length,
        message: `"${m[0]}" is a soft imperative; weak models treat it as optional. Use MUST / ALWAYS / NEVER or drop it.`,
        llm_fixable: true,
      });
    }
    return findingsFrom(ctx, softImperative, matches);
  },
};

/** ---- Rule: vague-quantifier ----------------------------------------- */

export const vagueQuantifier: Rule = {
  id: "vague-quantifier",
  tier: "deterministic",
  severity: "warn",
  description: "Use an exact number instead of some / several / a few / many / most.",
  check(ctx) {
    const re = /\b(some|several|a few|many|most of|a number of|numerous|various)\b/gi;
    const matches: Array<{ start: number; end: number; message: string; llm_fixable?: boolean }> = [];
    for (const m of scanMatches(ctx.source, re, skip(ctx))) {
      matches.push({
        start: m.index,
        end: m.index + m[0].length,
        message: `"${m[0]}" has no operational meaning. Give a number, a range, or an upper bound.`,
        llm_fixable: true,
      });
    }
    return findingsFrom(ctx, vagueQuantifier, matches);
  },
};

/** ---- Rule: taste-word ------------------------------------------------ */

export const tasteWord: Rule = {
  id: "taste-word",
  tier: "deterministic",
  severity: "warn",
  description: "Remove taste-based words; weak models can't evaluate them.",
  check(ctx) {
    const builtin = [
      "creative",
      "engaging",
      "appropriate",
      "polished",
      "natural",
      "nice",
      "good",
      "great",
      "feel free",
      "as needed",
      "when relevant",
      "if appropriate",
      "as appropriate",
      "passionate",
      "leveraged",
      "utilized",
      "spearheaded",
      "cutting-edge",
      "world-class",
      "best-in-class",
      "robust",
      "seamless",
      "synergy",
      "holistic",
    ];
    const extra = (ctx.config.options["taste-word.extra"] as string[] | undefined) ?? [];
    const words = [...builtin, ...extra];
    const re = new RegExp(`\\b(${words.map(escapeRe).join("|")})\\b`, "gi");
    const matches: Array<{ start: number; end: number; message: string; llm_fixable?: boolean }> = [];
    for (const m of scanMatches(ctx.source, re, skip(ctx))) {
      matches.push({
        start: m.index,
        end: m.index + m[0].length,
        message: `"${m[0]}" is taste-based; weak models can't evaluate it. Replace with a measurable rule.`,
        llm_fixable: true,
      });
    }
    return findingsFrom(ctx, tasteWord, matches);
  },
};

/** ---- Rule: ambiguous-deictic ---------------------------------------- */

export const ambiguousDeictic: Rule = {
  id: "ambiguous-deictic",
  tier: "deterministic",
  severity: "info",
  description: "Prefer explicit refs over 'above' / 'below' / 'the following' — weak models lose position.",
  check(ctx) {
    const re = /\b(the section above|section below|above section|below section|as mentioned above|as noted above|as described below|the table above|the table below)\b/gi;
    const matches: Array<{ start: number; end: number; message: string; llm_fixable?: boolean }> = [];
    for (const m of scanMatches(ctx.source, re, skip(ctx))) {
      matches.push({
        start: m.index,
        end: m.index + m[0].length,
        message: `"${m[0]}" relies on position. Name the section explicitly (e.g., "Block A — Role Summary").`,
        llm_fixable: true,
      });
    }
    return findingsFrom(ctx, ambiguousDeictic, matches);
  },
};

/** ---- Rule: double-negation ------------------------------------------ */

export const doubleNegation: Rule = {
  id: "double-negation",
  tier: "deterministic",
  severity: "warn",
  description: "Avoid double negatives — weak models flip the sign.",
  check(ctx) {
    const re = /\b(don'?t\s+(?:forget\s+to\s+)?(?:not|never)|never\s+(?:not|fail to)|not\s+un\w+|cannot\s+not)\b/gi;
    const matches: Array<{ start: number; end: number; message: string; llm_fixable?: boolean }> = [];
    for (const m of scanMatches(ctx.source, re, skip(ctx))) {
      matches.push({
        start: m.index,
        end: m.index + m[0].length,
        message: `Double negative: "${m[0]}". Rewrite as a positive imperative.`,
        llm_fixable: true,
      });
    }
    return findingsFrom(ctx, doubleNegation, matches);
  },
};

/** ---- Rule: long-sentence -------------------------------------------- */

export const longSentence: Rule = {
  id: "long-sentence",
  tier: "deterministic",
  severity: "info",
  description: "Split sentences longer than N words — weak models drop clauses.",
  check(ctx) {
    const max = (ctx.config.options["long-sentence.max_words"] as number | undefined) ?? 35;
    const skips = skip(ctx);
    const sentences = tokenizeSentences(ctx.source, skips);
    const matches: Array<{ start: number; end: number; message: string; llm_fixable?: boolean }> = [];

    for (const s of sentences) {
      const text = s.text.trim();
      if (text.startsWith("#") || text.startsWith(">")) continue;
      if (text.startsWith("|") || text.startsWith("- ") || text.startsWith("* ")) continue;
      // Strip markdown emphasis and inline-code backticks before counting
      // so **word** is one word, not two and not zero.
      const stripped = text.replace(/[*_`]+/g, "");
      const words = stripped.split(/\s+/).filter(Boolean);
      if (words.length > max) {
        matches.push({
          start: s.start,
          end: s.end,
          message: `Sentence is ${words.length} words (max ${max}). Split into shorter statements.`,
          llm_fixable: true,
        });
      }
    }
    return findingsFrom(ctx, longSentence, matches);
  },
};

/** ---- Rule: pronoun-no-antecedent ------------------------------------ */

export const pronounNoAntecedent: Rule = {
  id: "pronoun-no-antecedent",
  tier: "deterministic",
  severity: "info",
  description: "Pronoun at the start of a sentence after a list/heading — weak models lose the antecedent.",
  check(ctx) {
    const lines = ctx.source.split("\n");
    const matches: Array<{ start: number; end: number; message: string; llm_fixable?: boolean }> = [];
    let offset = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const prev = lines[i - 1] ?? "";
      const trimmed = line.trimStart();
      const leading = line.length - trimmed.length;
      const start = offset + leading;

      const prevIsStructural =
        prev.trim() === "" ||
        prev.trim().startsWith("#") ||
        prev.trim().startsWith("|") ||
        prev.trim().startsWith("-") ||
        prev.trim().startsWith("*") ||
        prev.trim().startsWith("```");

      if (prevIsStructural) {
        const m = /^(It|This|That|They|These|Those)\b/.exec(trimmed);
        if (m) {
          matches.push({
            start,
            end: start + m[0].length,
            message: `"${m[0]}" at start of block has no clear antecedent. Name the noun explicitly.`,
            llm_fixable: true,
          });
        }
      }
      offset += line.length + 1;
    }
    const skips = skip(ctx);
    const filtered = matches.filter((m) => !skips.some(([s, e]) => m.start >= s && m.start < e));
    return findingsFrom(ctx, pronounNoAntecedent, filtered);
  },
};

/** ---- Rule: enum-without-list ---------------------------------------- */

export const enumWithoutList: Rule = {
  id: "enum-without-list",
  tier: "deterministic",
  severity: "warn",
  description: "Phrases like 'one of the usual/standard' must list the allowed values inline.",
  check(ctx) {
    const re = /\bone of (?:the )?(?:usual|standard|typical|common|known) (?:categories|values|options|types)\b/gi;
    const matches: Array<{ start: number; end: number; message: string; llm_fixable?: boolean }> = [];
    for (const m of scanMatches(ctx.source, re, skip(ctx))) {
      matches.push({
        start: m.index,
        end: m.index + m[0].length,
        message: `Enum referenced without values. List the allowed values inline: "one of [a, b, c]".`,
        llm_fixable: true,
      });
    }
    return findingsFrom(ctx, enumWithoutList, matches);
  },
};

/** ---- Rule: word-count-target ---------------------------------------- */

export const wordCountTarget: Rule = {
  id: "word-count-target",
  tier: "deterministic",
  severity: "info",
  description: "Prefer character / sentence counts over word counts — weak models count tokens poorly.",
  check(ctx) {
    const re = /\b(\d+)[-–—]?(?:\s*(?:to|-)\s*\d+)?\s*words?\b/gi;
    const matches: Array<{ start: number; end: number; message: string; llm_fixable?: boolean }> = [];
    for (const m of scanMatches(ctx.source, re, skip(ctx))) {
      matches.push({
        start: m.index,
        end: m.index + m[0].length,
        message: `"${m[0]}" — weak models count words unreliably. Prefer characters ("max 240 chars") or sentences ("2-3 sentences").`,
        llm_fixable: true,
      });
    }
    return findingsFrom(ctx, wordCountTarget, matches);
  },
};

/** ---- Rule: implicit-conditional ------------------------------------- */

export const implicitConditional: Rule = {
  id: "implicit-conditional",
  tier: "deterministic",
  severity: "warn",
  description: "Conditional with no operational trigger (when/if relevant, as needed, if appropriate).",
  check(ctx) {
    const re = /\b(when (?:relevant|appropriate|needed|necessary)|as (?:needed|appropriate)|if (?:relevant|appropriate|needed|necessary)|where (?:relevant|appropriate|needed))\b/gi;
    const matches: Array<{ start: number; end: number; message: string; llm_fixable?: boolean }> = [];
    for (const m of scanMatches(ctx.source, re, skip(ctx))) {
      matches.push({
        start: m.index,
        end: m.index + m[0].length,
        message: `"${m[0]}" has no operational trigger. State the exact condition ("if score >= 3.5", "if the field is missing").`,
        llm_fixable: true,
      });
    }
    return findingsFrom(ctx, implicitConditional, matches);
  },
};

/** ---- Rule: trailing-etc --------------------------------------------- */

export const trailingEtc: Rule = {
  id: "trailing-etc",
  tier: "deterministic",
  severity: "warn",
  description: "'etc.' in an instruction is an unclosed set — list the allowed values explicitly.",
  check(ctx) {
    const re = /\b(etc\.?|and so on|and such)\b/gi;
    const matches: Array<{ start: number; end: number; message: string; llm_fixable?: boolean }> = [];
    for (const m of scanMatches(ctx.source, re, skip(ctx))) {
      matches.push({
        start: m.index,
        end: m.index + m[0].length,
        message: `"${m[0]}" leaves the set open. Weak models invent items. List every allowed value explicitly.`,
        llm_fixable: true,
      });
    }
    return findingsFrom(ctx, trailingEtc, matches);
  },
};

/** ---- Rule: heading-without-imperative ------------------------------- */

export const headingWithoutImperative: Rule = {
  id: "heading-without-imperative",
  tier: "deterministic",
  severity: "info",
  description: "Mode/step headings should begin with an imperative verb.",
  check(ctx) {
    if (!ctx.file.match(/modes\/|prompts\/|skills\/|agents\//i)) return [];
    const lines = ctx.source.split("\n");
    const skips = skip(ctx);
    const matches: Array<{ start: number; end: number; message: string; llm_fixable?: boolean }> = [];
    let offset = 0;
    const verbPattern = /^(Read|Write|Emit|Return|Extract|Classify|Generate|Validate|Compute|Save|Load|Scan|Detect|Build|Call|Fetch|Check|Verify|Update|Append|Skip|Fail|Use|Do|List|Count|Sum|Run|Execute|Apply|Parse|Render|Match|Map|Filter|Sort|Select|Pick|Output|Print|Dispatch|Route|Copy|Resolve|Compare|Score|Ignore|Ask|Reply|Include|Exclude)\b/;
    for (const line of lines) {
      const m = /^\s*(##+)\s+(Step\s+\d+\s*[—-]\s*|Block\s+[A-Z]\s*[—-]\s*)?(.+?)\s*$/.exec(line);
      if (m) {
        const headingText = m[3].trim();
        const headStart = offset + (m.index ?? 0) + line.indexOf(headingText);
        if (
          !verbPattern.test(headingText) &&
          !headingText.match(/^[A-Z][a-z]+(\s+[A-Z][a-z]+)+$/) &&
          !skips.some(([s, e]) => headStart >= s && headStart < e)
        ) {
          matches.push({
            start: headStart,
            end: headStart + headingText.length,
            message: `Heading "${headingText}" does not start with an imperative verb. Weak models skip non-actionable headings.`,
            llm_fixable: true,
          });
        }
      }
      offset += line.length + 1;
    }
    return findingsFrom(ctx, headingWithoutImperative, matches);
  },
};

/** ---- Rule: nested-conditional --------------------------------------- */

export const nestedConditional: Rule = {
  id: "nested-conditional",
  tier: "deterministic",
  severity: "warn",
  description: "Multiple if/unless/except in one sentence — split into a decision table or ordered list.",
  check(ctx) {
    const skips = skip(ctx);
    const sentences = tokenizeSentences(ctx.source, skips);
    const matches: Array<{ start: number; end: number; message: string; llm_fixable?: boolean }> = [];
    for (const s of sentences) {
      const text = s.text;
      const count =
        (text.match(/\bif\b/gi)?.length ?? 0) +
        (text.match(/\bunless\b/gi)?.length ?? 0) +
        (text.match(/\bexcept\b/gi)?.length ?? 0) +
        (text.match(/\bwhen\b/gi)?.length ?? 0);
      if (count >= 3) {
        matches.push({
          start: s.start,
          end: s.end,
          message: `Sentence has ${count} conditional clauses. Rewrite as a decision table or ordered if/else-if list.`,
          llm_fixable: true,
        });
      }
    }
    return findingsFrom(ctx, nestedConditional, matches);
  },
};

/** ---- Rule: multiple-output-formats ---------------------------------- */

export const multipleOutputFormats: Rule = {
  id: "multiple-output-formats",
  tier: "deterministic",
  severity: "warn",
  description: "One step must return one format — don't ask for JSON and also a summary.",
  check(ctx) {
    const re = /\b(return|output|emit|produce)\b[^.!?\n]{0,120}\b(and\s+(?:also|then))\b[^.!?\n]{0,120}\b(summary|explanation|commentary|markdown|prose|json|list|yaml)\b/gi;
    const matches: Array<{ start: number; end: number; message: string; llm_fixable?: boolean }> = [];
    for (const m of scanMatches(ctx.source, re, skip(ctx))) {
      matches.push({
        start: m.index,
        end: m.index + m[0].length,
        message: `Step asks for two output formats. Weak models drop one. Split into two steps.`,
        llm_fixable: true,
      });
    }
    return findingsFrom(ctx, multipleOutputFormats, matches);
  },
};

/** ---- Rule: output-format-no-example --------------------------------- */

/**
 * Flags "return/output JSON/YAML" declarations with no example or schema
 * within a short lookahead. Weak models hallucinate the shape without one.
 *
 * Satisfied by any of (within the next 10 lines):
 *   - a fenced code block
 *   - ≥2 bullet list items (treated as a schema / field list)
 *   - an inline JSON-shaped object on the same line (`{ ... }`)
 */
export const outputFormatNoExample: Rule = {
  id: "output-format-no-example",
  tier: "deterministic",
  severity: "warn",
  description: "Output-format declarations must be followed by an example or field list.",
  check(ctx) {
    const source = ctx.source;
    const skips = skip(ctx);
    const matches: Array<{ start: number; end: number; message: string; llm_fixable?: boolean }> = [];
    const decl = /\b(return|returns|returning|output|outputs|emit|emits|produce|produces|respond with)\s+(?:a\s+|an\s+|the\s+)?(JSON|YAML|XML|TOML|CSV)\b/gi;
    const lineStarts = ctx.line_starts;

    for (const m of scanMatches(source, decl, skips)) {
      const declLine = findLine(lineStarts, m.index);
      const targetLine = declLine + 10;
      const lookaheadEnd = targetLine >= lineStarts.length ? source.length : lineStarts[targetLine];
      const windowText = source.slice(m.index, lookaheadEnd);

      const hasCodeFence = /^(```+|~~~+)/m.test(windowText);
      const hasInlineObject = /\{[\s\S]{1,200}?\}/.test(windowText);
      const bulletMatches = windowText.match(/^\s*[-*+]\s/gm);
      const hasBulletList = (bulletMatches?.length ?? 0) >= 2;
      // Inline backtick-quoted field names: "Return JSON with a `name` field
      // (string) and a `score` field" is a schema hint, not hallucination bait.
      const inlineFields = windowText.match(/`[A-Za-z_][\w.]*`/g);
      const hasInlineFields = (inlineFields?.length ?? 0) >= 2;

      if (!hasCodeFence && !hasInlineObject && !hasBulletList && !hasInlineFields) {
        matches.push({
          start: m.index,
          end: m.index + m[0].length,
          message: `"${m[0]}" has no example or field list nearby. Weak models hallucinate the shape. Add a fenced example or a bullet list of fields.`,
          llm_fixable: true,
        });
      }
    }
    return findingsFrom(ctx, outputFormatNoExample, matches);
  },
};

/** ---- Rule: numbered-step-gap ---------------------------------------- */

/**
 * Detects broken step numbering at the same indentation level:
 *   1. Do X
 *   2. Do Y
 *   4. Do Z     ← jumps from 2 to 4 (missing 3)
 *
 * Weak models inherit the gap — they skip the corresponding step. Reports the
 * first missing number only (users usually fix numbering manually).
 */
export const numberedStepGap: Rule = {
  id: "numbered-step-gap",
  tier: "deterministic",
  severity: "warn",
  description: "Numbered lists with gaps — weak models follow structural errors.",
  check(ctx) {
    const source = ctx.source;
    const skips = skip(ctx);
    const lines = source.split("\n");
    const matches: Array<{ start: number; end: number; message: string; llm_fixable?: boolean }> = [];

    interface Run {
      /** Indentation (whitespace prefix length). */
      indent: number;
      last: number;
      lineIdx: number;
      offset: number;
    }
    let run: Run | null = null;
    let offset = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const m = /^(\s*)(\d+)\.\s/.exec(line);
      if (m) {
        const indent = m[1].length;
        const num = parseInt(m[2], 10);
        const itemOffset = offset + indent;
        if (run && run.indent === indent) {
          if (num !== run.last + 1 && num > run.last) {
            if (!skips.some(([s, e]) => itemOffset >= s && itemOffset < e)) {
              matches.push({
                start: itemOffset,
                end: itemOffset + m[0].length - 1,
                message: `Numbered list jumps from ${run.last} to ${num}. Weak models inherit the gap and skip the step.`,
              });
            }
            run = { indent, last: num, lineIdx: i, offset: itemOffset };
          } else {
            run.last = num;
          }
        } else {
          run = { indent, last: num, lineIdx: i, offset: itemOffset };
        }
      } else if (line.trim() === "" && run) {
        // A blank line breaks a list run — reset.
        run = null;
      }
      offset += line.length + 1;
    }
    return findingsFrom(ctx, numberedStepGap, matches);
  },
};

/** ---- Rule: step-without-verb ---------------------------------------- */

/**
 * A "## Step N" heading whose body doesn't open with an imperative verb.
 * Weak models skim step bodies looking for a verb to anchor on — "Configuration
 * of the pipeline" loses them; "Configure the pipeline" doesn't.
 *
 * Only runs on harness-file paths (modes/, prompts/, skills/, agents/).
 */
export const stepWithoutVerb: Rule = {
  id: "step-without-verb",
  tier: "deterministic",
  severity: "info",
  description: "Step bodies should open with an imperative verb, not a noun or description.",
  check(ctx) {
    if (!ctx.file.match(/modes\/|prompts\/|skills\/|agents\/|\.cursor\/rules/i)) return [];
    const source = ctx.source;
    const lines = source.split("\n");
    const matches: Array<{ start: number; end: number; message: string; llm_fixable?: boolean }> = [];
    const verbStart = /^(?:\*\*)?(?:Read|Write|Emit|Return|Extract|Classify|Generate|Validate|Compute|Save|Load|Scan|Detect|Build|Call|Fetch|Check|Verify|Update|Append|Skip|Fail|Use|Do|List|Count|Sum|Run|Execute|Apply|Parse|Render|Match|Map|Filter|Sort|Select|Pick|Output|Print|Dispatch|Route|Copy|Resolve|Compare|Score|Ignore|Ask|Reply|Include|Exclude|Configure|Set|Create|Add|Remove|Replace|Modify|Split|Join|Merge|Evaluate|Decide|Choose|Assign|Test|Try|Confirm|Normalize|Convert|Format|Sanitize|Deduplicate|Identify)\b/;
    let offset = 0;
    for (let i = 0; i < lines.length; i++) {
      const heading = /^##+\s+(?:Step|Block)\s+[A-Z0-9]+\s*[—\-:]\s*.+$/.exec(lines[i]);
      if (heading) {
        // Find the first non-empty, non-heading line in the body.
        let j = i + 1;
        let bodyOffset = offset + lines[i].length + 1;
        while (j < lines.length) {
          const body = lines[j];
          if (body.trim() !== "" && !/^#+\s/.test(body)) {
            const trimmed = body.replace(/^\s*[-*+]\s+/, "").trimStart();
            if (!verbStart.test(trimmed)) {
              const firstNonSpace = body.length - body.trimStart().length;
              matches.push({
                start: bodyOffset + firstNonSpace,
                end: bodyOffset + body.length,
                message: `Step body opens without an imperative verb: "${truncate(trimmed, 60)}". Weak models need a verb to anchor on.`,
                llm_fixable: true,
              });
            }
            break;
          }
          bodyOffset += body.length + 1;
          j++;
        }
      }
      offset += lines[i].length + 1;
    }
    return findingsFrom(ctx, stepWithoutVerb, matches);
  },
};

function findLine(lineStarts: number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

/** ---- Rule: placeholder-leftover ------------------------------------- */

export const placeholderLeftover: Rule = {
  id: "placeholder-leftover",
  tier: "deterministic",
  severity: "warn",
  description: "Catches leftover scaffolding (TODO, FIXME, <insert X>) that weak models echo verbatim.",
  check(ctx) {
    const matches: Array<{ start: number; end: number; message: string; llm_fixable?: boolean }> = [];
    const skips = skip(ctx);

    // 1. Bare keywords (case-sensitive — lowercase "todo" is often prose).
    const keywords = /\b(TODO|FIXME|TBD|XXX|HACK|WIP)\b/g;
    for (const m of scanMatches(ctx.source, keywords, skips)) {
      matches.push({
        start: m.index,
        end: m.index + m[0].length,
        message: `"${m[0]}" is leftover scaffolding. Weak models echo it verbatim. Remove or complete.`,
      });
    }

    // 2. Angle-bracket placeholders: <insert X>, <placeholder>, <your text here>, <TBD>.
    const angle = /<(insert[^>\n]*|placeholder[^>\n]*|your [^>\n]+|fill in[^>\n]*|TBD|TODO)>/gi;
    for (const m of scanMatches(ctx.source, angle, skips)) {
      matches.push({
        start: m.index,
        end: m.index + m[0].length,
        message: `"${m[0]}" is a placeholder. Weak models emit it literally. Replace with real content.`,
      });
    }

    // 3. Square-bracket placeholders: [INSERT X], [FILL IN], [YOUR TEXT].
    const square = /\[(INSERT[^\]\n]*|PLACEHOLDER[^\]\n]*|YOUR [^\]\n]+|FILL IN[^\]\n]*|TBD|TODO)\]/g;
    for (const m of scanMatches(ctx.source, square, skips)) {
      matches.push({
        start: m.index,
        end: m.index + m[0].length,
        message: `"${m[0]}" is a placeholder. Weak models emit it literally. Replace with real content.`,
      });
    }

    // 4. Handlebars-style {{var}} — opt-in (many legit templates use these).
    if (ctx.config.options["placeholder-leftover.include_handlebars"]) {
      const hb = /\{\{[^}\n]+\}\}/g;
      for (const m of scanMatches(ctx.source, hb, skips)) {
        matches.push({
          start: m.index,
          end: m.index + m[0].length,
          message: `"${m[0]}" looks like an unrendered template variable. Resolve before shipping.`,
        });
      }
    }

    return findingsFrom(ctx, placeholderLeftover, matches);
  },
};

/** ---- helpers -------------------------------------------------------- */

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Full deterministic ruleset, in priority order. */
export const DETERMINISTIC_RULES: Rule[] = [
  softImperative,
  vagueQuantifier,
  tasteWord,
  ambiguousDeictic,
  doubleNegation,
  longSentence,
  pronounNoAntecedent,
  enumWithoutList,
  wordCountTarget,
  implicitConditional,
  trailingEtc,
  headingWithoutImperative,
  nestedConditional,
  multipleOutputFormats,
  placeholderLeftover,
  outputFormatNoExample,
  numberedStepGap,
  stepWithoutVerb,
];
