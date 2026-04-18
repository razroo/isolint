import { collectHeadings, getAst, paragraphs } from "../ast.js";
import { tokenizeSentences, type Sentence } from "../sentences.js";
import { computeSkipIntervals, rangeFromOffsets } from "../source.js";
import type { Fix, LintContext, LintFinding, Rule } from "../types.js";

const HARNESS_PATH_RE = /(?:^|\/)(?:modes|prompts|skills|agents)(?:\/|$)|\.cursor\/rules/i;
const EXAMPLE_TITLE_RE = /\b(example|examples|sample|samples)\b/i;
const STEP_TITLE_RE = /^step\b/i;
const OUTPUT_VERB_RE = /\b(return|respond(?:\s+with)?|emit|output|provide)\b/i;
const STRUCTURED_OUTPUT_RE = /\b(json|yaml|yml|csv|table|object|array|list|xml)\b/i;
const ACTION_CUE_RE = /\b(return|emit|output|extract|classify|score|rank|validate|read|write|save|select|choose|set|check|parse|map|filter|compare|summarize|format|call|use|include|exclude)\b/gi;
const STRUCTURE_CUE_RE = /(\$input|\$steps\.|```|`[^`\n]+`|\bjson\b|\byaml\b|\bregex\b|\bschema\b|\bexactly\b|\bat most\b|\bat least\b|\bmust\b|\bnever\b|\b\d+\b|^\s*[-*]\s+)/gim;
const STYLE_TONE_RE = /\b(friendly|professional|warm|conversational|human(?:-sounding)?|natural|polite|empathetic|enthusiastic|persuasive|confident|approachable|on-brand|brand voice|tone|voice|style)\b/i;

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "if",
  "in", "into", "is", "it", "of", "on", "or", "that", "the", "their",
  "then", "there", "these", "this", "to", "use", "with", "your",
]);

interface SectionInfo {
  title: string;
  start_offset: number;
  content_start: number;
  end_offset: number;
}

interface ParagraphInfo {
  text: string;
  start: number;
  end: number;
  section: SectionInfo;
}

function inHarnessPath(ctx: LintContext): boolean {
  return HARNESS_PATH_RE.test(ctx.file);
}

function sentenceSkips(ctx: LintContext): [number, number][] {
  return computeSkipIntervals(ctx.source, {
    ...ctx.config.skip_spans,
    inline_code: false,
    quoted_strings: false,
  });
}

function findingAt(
  ctx: LintContext,
  rule: { id: string; severity: "error" | "warn" | "info" },
  start: number,
  end: number,
  message: string,
  snippet?: string,
  opts: { severity?: "error" | "warn" | "info"; fix?: Fix; llm_fixable?: boolean } = {},
): LintFinding {
  return {
    rule_id: rule.id,
    severity: opts.severity ?? rule.severity,
    file: ctx.file,
    range: rangeFromOffsets(ctx, start, Math.max(end, start + 1)),
    message,
    snippet: snippet ?? ctx.source.slice(start, end),
    ...(opts.fix ? { fix: opts.fix } : {}),
    ...(opts.llm_fixable ? { llm_fixable: true } : {}),
  };
}

function collectSections(ctx: LintContext): SectionInfo[] {
  const headings = collectHeadings(getAst(ctx));
  if (headings.length === 0) {
    return [{
      title: "(file)",
      start_offset: 0,
      content_start: 0,
      end_offset: ctx.source.length,
    }];
  }
  return headings.map((heading, index) => ({
    title: heading.text,
    start_offset: heading.start_offset,
    content_start: heading.end_offset,
    end_offset: headings[index + 1]?.start_offset ?? ctx.source.length,
  }));
}

function sectionAt(sections: SectionInfo[], offset: number): SectionInfo {
  let best = sections[0];
  for (const section of sections) {
    if (section.start_offset <= offset) best = section;
    else break;
  }
  return best;
}

function collectParagraphsBySection(ctx: LintContext, sections: SectionInfo[]): ParagraphInfo[] {
  const out: ParagraphInfo[] = [];
  for (const paragraph of paragraphs(getAst(ctx))) {
    const text = collapseWhitespace(paragraph.text);
    if (!text) continue;
    const section = sectionAt(sections, paragraph.start);
    out.push({ text, start: paragraph.start, end: paragraph.end, section });
  }
  return out;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function wordCount(text: string): number {
  return text.match(/[A-Za-z0-9$_.-]+/g)?.length ?? 0;
}

function normalizeExact(text: string): string {
  return text
    .toLowerCase()
    .replace(/\$steps\.[a-z0-9_-]+/g, "$steps")
    .replace(/\$input(?:\.[a-z0-9_.-]+)?/g, "$input")
    .replace(/\bstep\s+\d+\b/g, "step")
    .replace(/\bblock\s+[a-z0-9]+\b/g, "block")
    .replace(/[^a-z0-9$_\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function semanticTokens(text: string): string[] {
  return normalizeExact(text)
    .split(" ")
    .filter((token) => token.length > 2 && !STOPWORDS.has(token));
}

function jaccard(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let overlap = 0;
  for (const token of setA) {
    if (setB.has(token)) overlap++;
  }
  return overlap / (setA.size + setB.size - overlap);
}

function looksInstructional(text: string): boolean {
  return /\b(return|emit|output|extract|classify|score|rank|validate|read|write|save|select|choose|set|check|parse|map|filter|compare|summarize|format|call|include|exclude|must|always|never)\b/i.test(text);
}

function sectionLabel(section: SectionInfo): string {
  return section.title === "(file)" ? "earlier in the file" : `"${section.title}"`;
}

function truncate(text: string, max = 200): string {
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

function countMatches(text: string, pattern: RegExp): number {
  const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
  let count = 0;
  while (re.exec(text) !== null) count++;
  return count;
}

function firstSentence(text: string): string {
  const sentences = tokenizeSentences(text);
  return collapseWhitespace(sentences[0]?.text ?? text);
}

function hasNearbyStructuredContract(lines: string[], startLine: number, endLine: number): boolean {
  const lo = Math.max(0, startLine - 9);
  const hi = Math.min(lines.length - 1, endLine + 7);
  let fieldLines = 0;

  for (let i = lo; i <= hi; i++) {
    const line = lines[i].trim();
    if (/^```(?:json|yaml|yml)\b/i.test(line)) return true;
    if (/\b(json schema|schema:|properties:|required:|additionalProperties)\b/i.test(line)) return true;
    if (/^[-*]\s+/.test(line) && (/`[^`]+`/.test(line) || /^[A-Za-z0-9_.-]+\s*:/.test(line.slice(2)) || /\b(field|key|property)\b/i.test(line))) {
      fieldLines++;
    }
  }

  return fieldLines >= 2;
}

function buildTrailingToneFix(start: number, end: number, text: string): Fix | undefined {
  const match = /^(.*?)(?:,\s*)?\s+(?:in|with|using)\s+(?:a|an)?\s*([a-z][a-z\s,-]{0,80})\s+(tone|style)\s*([.?!])$/i.exec(text.trim());
  if (!match) return undefined;
  const prefix = match[1].trim().replace(/[,\s]+$/g, "");
  if (!prefix || /\b(and|or|but)$/i.test(prefix)) return undefined;
  const replacement = `${prefix}${match[4]}`;
  if (replacement === text) return undefined;
  return {
    start,
    end,
    replacement,
    description: "Remove trailing tone/style phrasing from a structured-output instruction.",
  };
}

/** ---- Rule: repeated instruction blocks ------------------------------- */

export const perfRepeatedInstructionBlock: Rule = {
  id: "perf-repeated-instruction-block",
  tier: "deterministic",
  severity: "info",
  description: "Repeated instruction paragraphs across sections waste context and tokens.",
  check(ctx) {
    if (!inHarnessPath(ctx)) return [];

    const sections = collectSections(ctx);
    const blocks = collectParagraphsBySection(ctx, sections)
      .filter((paragraph) => !EXAMPLE_TITLE_RE.test(paragraph.section.title))
      .filter((paragraph) => !STEP_TITLE_RE.test(paragraph.section.title))
      .filter((paragraph) => wordCount(paragraph.text) >= 8)
      .filter((paragraph) => looksInstructional(paragraph.text));

    const firstByKey = new Map<string, ParagraphInfo>();
    const findings: LintFinding[] = [];

    for (const block of blocks) {
      const key = normalizeExact(block.text);
      if (!key) continue;
      const earlier = firstByKey.get(key);
      if (!earlier) {
        firstByKey.set(key, block);
        continue;
      }
      if (earlier.section.title === block.section.title) continue;
      findings.push(
        findingAt(
          ctx,
          perfRepeatedInstructionBlock,
          block.start,
          block.end,
          `This instruction block repeats guidance already present in ${sectionLabel(earlier.section)}. Reuse one shared block instead of duplicating it.`,
        ),
      );
    }

    return findings;
  },
};

/** ---- Rule: example-heavy section ------------------------------------ */

export const perfExampleHeavySection: Rule = {
  id: "perf-example-heavy-section",
  tier: "deterministic",
  severity: "info",
  description: "Examples that outweigh the task definition consume context without improving execution.",
  check(ctx) {
    if (!inHarnessPath(ctx)) return [];

    const sections = collectSections(ctx);
    const exampleSections = sections.filter((section) => EXAMPLE_TITLE_RE.test(section.title));
    if (exampleSections.length === 0) return [];

    const nonExampleWords = sections
      .filter((section) => !EXAMPLE_TITLE_RE.test(section.title))
      .reduce((sum, section) => sum + wordCount(ctx.source.slice(section.content_start, section.end_offset)), 0);

    const findings: LintFinding[] = [];
    for (const section of exampleSections) {
      const words = wordCount(ctx.source.slice(section.content_start, section.end_offset));
      if (words < 120) continue;
      if (nonExampleWords > 0 && words <= nonExampleWords * 1.25) continue;
      findings.push(
        findingAt(
          ctx,
          perfExampleHeavySection,
          section.start_offset,
          section.content_start,
          `Section "${section.title}" is ${words} words, which outweighs the task-defining instructions (${nonExampleWords} words). Trim or externalize the example.`,
          section.title,
        ),
      );
    }

    return findings;
  },
};

/** ---- Rule: duplicated output requirements --------------------------- */

export const perfDuplicatedOutputRequirement: Rule = {
  id: "perf-duplicated-output-requirement",
  tier: "deterministic",
  severity: "info",
  description: "Repeated output contracts add tokens without changing behavior.",
  examples: [
    {
      bad: "Return JSON with fields score and reason. Use the same JSON format as above.",
      good: "Return the result using the existing JSON format.",
      why: "Avoid restating the wire format when the contract already exists nearby.",
    },
  ],
  check(ctx) {
    if (!inHarnessPath(ctx)) return [];

    const sections = collectSections(ctx);
    const sentences = tokenizeSentences(ctx.source, sentenceSkips(ctx));
    const firstByKey = new Map<string, { sentence: Sentence; section: SectionInfo }>();
    const findings: LintFinding[] = [];

    for (const sentence of sentences) {
      const text = collapseWhitespace(sentence.text);
      if (wordCount(text) < 5) continue;
      if (!OUTPUT_VERB_RE.test(text) || !STRUCTURED_OUTPUT_RE.test(text)) continue;

      const key = normalizeExact(text);
      const section = sectionAt(sections, sentence.start);
      const earlier = firstByKey.get(key);
      if (!earlier) {
        firstByKey.set(key, { sentence, section });
        continue;
      }

      findings.push(
        findingAt(
          ctx,
          perfDuplicatedOutputRequirement,
          sentence.start,
          sentence.end,
          `This output requirement duplicates guidance already stated in ${sectionLabel(earlier.section)}. Keep one contract source and point later steps at it.`,
          undefined,
          { llm_fixable: true },
        ),
      );
    }

    return findings;
  },
};

/** ---- Rule: step restates prior step -------------------------------- */

export const perfStepRestatesPriorStep: Rule = {
  id: "perf-step-restates-prior-step",
  tier: "deterministic",
  severity: "warn",
  description: "A later step that mostly repeats an earlier step adds latency without new work.",
  check(ctx) {
    if (!inHarnessPath(ctx)) return [];

    const sections = collectSections(ctx).filter((section) => STEP_TITLE_RE.test(section.title));
    if (sections.length < 2) return [];

    const stepBodies = sections
      .map((section) => ({
        section,
        text: collapseWhitespace(ctx.source.slice(section.content_start, section.end_offset)),
      }))
      .filter((entry) => wordCount(entry.text) >= 10)
      .map((entry) => ({ ...entry, tokens: semanticTokens(entry.text) }));

    const findings: LintFinding[] = [];
    for (let i = 1; i < stepBodies.length; i++) {
      const current = stepBodies[i];
      const currentNorm = normalizeExact(current.text);
      let best: { section: SectionInfo; score: number } | null = null;

      for (let j = 0; j < i; j++) {
        const earlier = stepBodies[j];
        const earlierNorm = normalizeExact(earlier.text);
        const score = Math.max(
          currentNorm === earlierNorm ? 1 : 0,
          currentNorm.includes(earlierNorm) || earlierNorm.includes(currentNorm) ? 0.9 : 0,
          jaccard(current.tokens, earlier.tokens),
        );
        if (!best || score > best.score) best = { section: earlier.section, score };
      }

      if (!best || best.score < 0.8) continue;

      findings.push(
        findingAt(
          ctx,
          perfStepRestatesPriorStep,
          current.section.start_offset,
          current.section.content_start,
          `${sectionLabel(current.section)} mostly restates ${sectionLabel(best.section)}. Merge the steps or make the later step do distinct work.`,
          truncate(firstSentence(current.text)),
        ),
      );
    }

    return findings;
  },
};

/** ---- Rule: low-value prose section --------------------------------- */

export const perfLowValueProseSection: Rule = {
  id: "perf-low-value-prose-section",
  tier: "deterministic",
  severity: "info",
  description: "Large narrative sections with few operational cues waste prompt budget.",
  check(ctx) {
    if (!inHarnessPath(ctx)) return [];

    const sections = collectSections(ctx);
    const findings: LintFinding[] = [];

    for (const section of sections) {
      if (EXAMPLE_TITLE_RE.test(section.title)) continue;
      const body = ctx.source.slice(section.content_start, section.end_offset);
      const words = wordCount(body);
      if (words < 120) continue;

      const cues = countMatches(body, ACTION_CUE_RE) + countMatches(body, STRUCTURE_CUE_RE);
      if (cues >= Math.ceil(words / 60)) continue;

      findings.push(
        findingAt(
          ctx,
          perfLowValueProseSection,
          section.start_offset,
          section.content_start,
          `Section "${section.title}" is ${words} words but has only ${cues} operational cue${cues === 1 ? "" : "s"}. Trim narrative guidance or move it out of the runtime harness.`,
          section.title,
        ),
      );
    }

    return findings;
  },
};

/** ---- Rule: redundant schema prose ---------------------------------- */

export const perfRedundantSchemaProse: Rule = {
  id: "perf-redundant-schema-prose",
  tier: "deterministic",
  severity: "info",
  description: "When a nearby schema or example already defines the contract, prose restating it is redundant.",
  examples: [
    {
      bad: "Return JSON with fields title, owner, and score.",
      good: "Return the result using the schema below.",
      why: "If a nearby schema or field list already defines the structure, keep the prose focused on the task.",
    },
  ],
  check(ctx) {
    if (!inHarnessPath(ctx)) return [];

    const lines = ctx.source.split("\n");
    const sentences = tokenizeSentences(ctx.source, sentenceSkips(ctx));
    const findings: LintFinding[] = [];

    for (const sentence of sentences) {
      const text = collapseWhitespace(sentence.text);
      if (!OUTPUT_VERB_RE.test(text)) continue;
      if (!/\b(json|yaml|object|schema|fields?|keys?|properties|shape)\b/i.test(text)) continue;

      const range = rangeFromOffsets(ctx, sentence.start, sentence.end);
      if (!hasNearbyStructuredContract(lines, range.line - 1, (range.end_line ?? range.line) - 1)) continue;

      findings.push(
        findingAt(
          ctx,
          perfRedundantSchemaProse,
          sentence.start,
          sentence.end,
          "This prose repeats a nearby schema, field list, or structured example. Keep one contract source instead of duplicating it.",
          undefined,
          { llm_fixable: true },
        ),
      );
    }

    return findings;
  },
};

/** ---- Rule: structured output + explanation -------------------------- */

export const perfStructuredOutputExplanation: Rule = {
  id: "perf-structured-output-explanation",
  tier: "deterministic",
  severity: "warn",
  description: "Requiring free-form explanation alongside structured output adds tokens and latency.",
  check(ctx) {
    if (!inHarnessPath(ctx)) return [];

    const sentences = tokenizeSentences(ctx.source, sentenceSkips(ctx));
    const findings: LintFinding[] = [];

    for (const sentence of sentences) {
      const text = collapseWhitespace(sentence.text);
      if (!STRUCTURED_OUTPUT_RE.test(text)) continue;
      if (!/\b(and|plus|along with|together with)\b/i.test(text)) continue;
      if (!/\b(explain|explanation|justify|justification|describe why|include (?:a )?(?:short )?(?:explanation|rationale|analysis)|add (?:a )?(?:short )?(?:explanation|rationale|analysis)|show (?:your )?reasoning)\b/i.test(text)) continue;
      if (/\b(field|key|property)\b/i.test(text)) continue;

      findings.push(
        findingAt(
          ctx,
          perfStructuredOutputExplanation,
          sentence.start,
          sentence.end,
          "This step asks for structured output plus a separate explanation. Drop the explanation or encode it as a field if the consumer truly needs it.",
        ),
      );
    }

    return findings;
  },
};

/** ---- Rule: style / tone overhead ----------------------------------- */

export const perfStyleToneOverhead: Rule = {
  id: "perf-style-tone-overhead",
  tier: "deterministic",
  severity: "info",
  description: "Tone instructions on structured outputs add context without changing the contract.",
  examples: [
    {
      bad: "Return JSON in a friendly, conversational tone.",
      good: "Return JSON.",
      why: "Tone guidance does not change a structured contract and wastes prompt budget.",
    },
  ],
  check(ctx) {
    if (!inHarnessPath(ctx)) return [];

    const sentences = tokenizeSentences(ctx.source, sentenceSkips(ctx));
    const findings: LintFinding[] = [];

    for (const sentence of sentences) {
      const text = collapseWhitespace(sentence.text);
      if (!OUTPUT_VERB_RE.test(text)) continue;
      if (!STRUCTURED_OUTPUT_RE.test(text)) continue;
      if (!STYLE_TONE_RE.test(text)) continue;

      findings.push(
        findingAt(
          ctx,
          perfStyleToneOverhead,
          sentence.start,
          sentence.end,
          "Tone or style guidance on a structured output usually adds tokens without changing execution. Keep it only if a user reads the prose directly.",
          undefined,
          {
            llm_fixable: true,
            fix: buildTrailingToneFix(sentence.start, sentence.end, sentence.text),
          },
        ),
      );
    }

    return findings;
  },
};

export const PERFORMANCE_RULES: Rule[] = [
  perfRepeatedInstructionBlock,
  perfExampleHeavySection,
  perfDuplicatedOutputRequirement,
  perfStepRestatesPriorStep,
  perfLowValueProseSection,
  perfRedundantSchemaProse,
  perfStructuredOutputExplanation,
  perfStyleToneOverhead,
];
