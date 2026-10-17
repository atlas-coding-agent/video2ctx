import { renderCitedBlocks } from './answer-citations';
import { mapCitationProse, trimCitationProse, LINK_NODES, literalSpans } from './markdown-citations';
import { parsePartialJson } from 'ai';
import { z } from 'zod';
import { finalizeAnswerInputSchema, type FinalizeAnswerInput } from './contracts';

/** Model-facing only. Citation placement metadata is owned by the application. */
const fields = finalizeAnswerInputSchema.omit({ answer: true, citations: true, citationGroups: true, intent: true }).extend({
  warnings: z.array(z.object({
    code: z.enum(['SOURCE_CAVEAT', 'ANSWER_SCOPE_SHORTFALL']).describe('SOURCE_CAVEAT: limitations of sources, such as unverified demos. ANSWER_SCOPE_SHORTFALL: a specific requested item, count, or question could not be answered. Source uncertainty alone is not an unmet request.'),
    message: z.string().min(1).max(1_000),
    unansweredPart: z.string().max(400).optional().describe('Required to mark ANSWER_SCOPE_SHORTFALL as partial: identify the specific requested item, count, or question that this answer leaves unanswered. Do not list a source limitation or an extra requirement the user did not ask for. Omit for SOURCE_CAVEAT. Without a nonblank unansweredPart the warning remains a source caveat.'),
  })).max(3).default([]).describe('At most three distinct, material limitations. The application already returns warnings from the evidence packets. Do not repeat inherited warnings, summarize the answer, or discuss generating the response.'),
});
const block = z.object({
  // The SDK bounds generation tokens and the rendered contract bounds total
  // characters. A decoding limit on each paragraph can split words at its edge.
  text: z.string().min(1).regex(/\S/, 'A block must contain non-whitespace text.').describe('One complete paragraph, list item, or Markdown table. Finish the table within this block. End prose at a natural sentence boundary; never continue a sentence in the next block. Put all citations only in evidenceIds, including for tables. The application strips inline citation annotations and appends block-level links. Do not add Source cells or row-level citation markers. Never write bare aliases or reference ranges as citations.'),
  evidenceIds: z.array(z.string().regex(/^[A-Za-z0-9:_-]+$/).max(300)).min(1).max(12).describe('Individual supplied evidence IDs supporting this block. List each ID separately, without ranges or duplicates. The application renders these as citations.'),
});
// Executable routes require references in the transmitted JSON schema itself.
// Do not hide model-facing requirements in refinements that JSON Schema omits.
export const structuredAnswerSchema = fields.extend({
  intent: z.enum(['topic_research', 'inspect_video']),
  blocks: z.array(block).min(1).max(20),
});

export const clarificationAnswerSchema = fields.extend({
  intent: z.enum(['clarification', 'rejected']),
  blocks: z.array(block.extend({ evidenceIds: z.array(block.shape.evidenceIds.element).max(0) })).length(1),
});

export const contextAnswerSchema = fields.extend({
  intent: z.literal('context_answer'),
  blocks: z.array(block.extend({
    evidenceIds: z.array(block.shape.evidenceIds.element).max(12).describe('List individual supplied evidence IDs for video facts, without ranges or duplicates. The application renders these as citations. Use no evidence IDs only when discussing prior conversation statements, without treating them as verified video facts.'),
  })).min(1).max(20),
});

// The classifier owns intent; persisted evidence owns artifacts and citations.
export const finalizationOutputSchema = structuredAnswerSchema.omit({ intent: true, artifacts: true });
export const contextFinalizationOutputSchema = contextAnswerSchema.omit({ intent: true, artifacts: true });
export const conversationalFinalizationOutputSchema = clarificationAnswerSchema.omit({ intent: true, artifacts: true });
export const FINALIZATION_SCHEMA_VERSION = 'answer-blocks-v5';

/** Log-only signal. A count mismatch never rejects an answer. */
export function numberedItemsMismatch(output: Pick<z.infer<typeof finalizationOutputSchema>, 'blocks' | 'warnings'>, expected: number | undefined): boolean {
  if (expected === undefined || output.warnings.some(warning => warning.code === 'ANSWER_SCOPE_SHORTFALL' && warning.unansweredPart?.trim())) return false;
  const numbers = new Set([...output.blocks.map(block => block.text).join('\n').matchAll(
    /(?:^|\n)[ \t]*(?:#{1,6}[ \t]+)?(?:\*\*)?(\d+)[.)][ \t]+/g,
  )].map(match => Number(match[1])));
  return numbers.size !== expected || !Array.from({ length: expected }, (_, index) => index + 1).every(number => numbers.has(number));
}

/** An answer made only of filler or a promise of future work is not an answer. */
export function fillerOnlyAnswer(output: { blocks: { text: string }[] }): boolean {
  const fragment = /^(?:the|a|an|and|but|because|however|therefore)[,:]?$/i;
  const promise = /^(?:I(?:['’]ll| will| am going to)|Let me) (?:first )?(?:look up|check|search|retrieve|fetch|inspect|read|analy[sz]e)\b[^.!?]*(?:[.!?])?$/i;
  return output.blocks.every(block => fragment.test(block.text.trim()) || promise.test(block.text.trim()));
}

/** Keep the complete blocks of an answer cut off at the output-token limit. A block
 * counts as complete only if its own object closed in the raw text. JSON that closes
 * cleanly despite the limit is kept whole and reported, so the case stays measurable. */
export async function salvageTruncatedAnswer<T extends { blocks: unknown[] }>(candidate: string | undefined, schema: z.ZodType<T>): Promise<{ output: T; droppedBlock: boolean; closedCleanly: boolean } | undefined> {
  const { value, state } = await parsePartialJson(candidate);
  if (state !== 'repaired-parse' && state !== 'successful-parse') return undefined;
  if (!value || typeof value !== 'object' || !Array.isArray((value as { blocks?: unknown }).blocks)) return undefined;
  const blocks = (value as { blocks: unknown[] }).blocks;
  const closedCleanly = state === 'successful-parse';
  const keep = closedCleanly ? blocks.length : Math.min(blocks.length, closedBlockCount(candidate!));
  if (keep < 1) return undefined;
  const parsed = schema.safeParse({ ...value, blocks: blocks.slice(0, keep) });
  return parsed.success ? { output: parsed.data, droppedBlock: keep < blocks.length, closedCleanly } : undefined;
}

/** Count entries of the top-level `blocks` array whose objects close in raw JSON text. */
function closedBlockCount(text: string): number {
  const stack: string[] = [];
  let inString = false, escaped = false, token = '', lastKey: string | undefined, blocksDepth = -1, closed = 0;
  for (const char of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') { inString = false; if (stack.length === 1) lastKey = token; }
      else token += char;
    } else if (char === '"') { inString = true; token = ''; }
    else if (char === '{' || char === '[') {
      if (char === '[' && stack.length === 1 && lastKey === 'blocks') blocksDepth = 2;
      stack.push(char);
    } else if (char === '}' || char === ']') {
      stack.pop();
      if (char === '}' && stack.length === blocksDepth) closed += 1;
      if (stack.length < blocksDepth) blocksDepth = -1;
    } else if (char === ',' && stack.length === 1) lastKey = undefined;
  }
  return closed;
}

/** Render provisional model text only. Citations remain hidden until validation commits the answer. */
export function renderPartialAnswer(value: { blocks?: Array<{ text?: string } | undefined> }): string {
  return (value.blocks ?? []).flatMap(block => {
    if (typeof block?.text !== 'string' || !block.text.trim()) return [];
    return [trimCitationProse(mapCitationProse(block.text, prose => prose
      .replace(/【\s*ref_[^】\n]*(?:】|$)|\[\s*ref_[^\]\n]*(?:\]|$)/g, '')
      .replace(/\[cite:[^\]]*\]?/g, '')
      .replace(/\(source marker:[^\]]*\]?/g, ''), true), true)];
  }).filter(Boolean).join('\n\n').slice(0, 20_000);
}

const ALIAS = String.raw`ref_\d+`;
const RANGE_SEPARATOR = String.raw`(?:-|–|—|\bto\b|\bthrough\b|\bthru\b)`;
const ALIAS_ITEM = String.raw`${ALIAS}(?:\s*${RANGE_SEPARATOR}\s*(?:ref_)?\d+)?`;
const ALIAS_LIST = String.raw`${ALIAS_ITEM}(?:\s*,\s*${ALIAS_ITEM})*`;
const ALIAS_BEFORE = String.raw`(?<![\w\-./:=#?&%@~+$\\\[【'"‘“\x60])`;
const ALIAS_AFTER = String.raw`(?![\w\-/:(\]】'"’”\x60]|\.\w)`;
// Recognize annotation syntax, independent of whether its IDs exist. Inline IDs
// never become evidence. Consume ranges without enumerating their members.
const MODEL_REFERENCES = new RegExp(String.raw`(?<leading>(?:,[ \t]+)?[ \t]*)(?:` + [
  String.raw`\[cite:(?<canonical>[^\]]*)\]|\(source marker:(?<escaped>[^\]]*)\]`,
  String.raw`\[\s*(?<square>${ALIAS_LIST})\s*\]|【\s*(?<wide>${ALIAS_LIST})\s*】`,
  String.raw`(?<linked>\])?\(\s*(?:(?<attribution>[\p{L}][\p{L}\p{N} .’'-]{0,80}),\s*)?(?<group>${ALIAS_LIST})\s*\)`,
  String.raw`${ALIAS_BEFORE}(?<bare>${ALIAS_LIST})${ALIAS_AFTER}`,
].join('|') + String.raw`)(?<trailing>[ \t]*)`, 'gu');

/** Remove citation annotations in prose and tables without adopting their IDs.
 * Keep literal examples and attribution names unchanged. */
function stripAnswerReferences(text: string): string {
  const prose: Array<[number, number]> = [];
  mapCitationProse(text, (chunk, from, to) => { prose.push([from, to]); return chunk; }, false, LINK_NODES);
  const literals = literalSpans(text, prose);
  return mapCitationProse(text, (chunk, proseStart) => {
    let rendered = '', cursor = 0;
    for (const match of chunk.matchAll(MODEL_REFERENCES)) {
      const groups = match.groups!;
      const leading = groups.leading ?? '', trailing = groups.trailing ?? '';
      const start = proseStart + match.index! + leading.length;
      const end = proseStart + match.index! + match[0].length - trailing.length;
      rendered += chunk.slice(cursor, match.index);
      cursor = match.index! + match[0].length;
      if (groups.linked || literals.some(([from, to]) => start < to && end > from)) {
        rendered += match[0];
        continue;
      }
      if (groups.attribution) {
        rendered += `${leading}(${groups.attribution})${trailing}`;
      } else {
        // Remove only whitespace at a removed annotation's boundary. In particular,
        // adjacent markers must not leave a space before the sentence punctuation.
        rendered = rendered.replace(/[ \t]+$/, '');
        const next = chunk[cursor] ?? text[proseStart + cursor];
        if ((rendered || proseStart > 0) && next && !/[.,;:!?)\n]/.test(next) && (leading || trailing)) rendered += ' ';
      }
    }
    return rendered + chunk.slice(cursor);
  }, false, LINK_NODES);
}

/** Block arrays are the only citation authority, for prose and tables alike. */
export function blockReferences(block: { text: string; evidenceIds: readonly string[] }, aliases: ReadonlyMap<string, string> = new Map()): string[] {
  return [...new Set(block.evidenceIds.map(id => aliases.get(id) ?? id))];
}

export function renderStructuredAnswer(value: z.infer<typeof structuredAnswerSchema> | z.infer<typeof clarificationAnswerSchema> | z.infer<typeof contextAnswerSchema>, aliases: ReadonlyMap<string, string> = new Map()): FinalizeAnswerInput {
  const input = value.intent === 'clarification' || value.intent === 'rejected' ? clarificationAnswerSchema.parse(value)
    : value.intent === 'context_answer' ? contextAnswerSchema.parse(value) : structuredAnswerSchema.parse(value);
  // Not an answer at all: the one content check that still earns a repair.
  if (fillerOnlyAnswer(input)) throw new z.ZodError([{ code: 'custom', path: ['blocks'],
    message: 'The answer is only a fragment or promise of future work. Answer the request now, or state the concrete missing context. Do not report planned work as completed.' }]);
  const rendered = renderCitedBlocks(input.blocks.map(block => ({
    text: trimCitationProse(stripAnswerReferences(block.text)), evidenceIds: blockReferences(block, aliases),
  })));
  return finalizeAnswerInputSchema.parse({
    intent: input.intent,
    confidence: input.confidence,
    artifacts: input.artifacts,
    // A model's category alone is not evidence of an unmet request. Keep the
    // caveat, but only promote a separately identified unanswered part to partial.
    // Application-generated coverage/failure warnings are added outside this path.
    warnings: input.warnings.map(warning => {
      const unansweredPart = warning.unansweredPart?.trim();
      return warning.code === 'ANSWER_SCOPE_SHORTFALL' && unansweredPart
        ? { code: 'PARTIAL_EVIDENCE', message: `Unanswered request: ${unansweredPart}. ${warning.message}`.slice(0, 1_000) }
        : { code: 'SOURCE_CAVEAT', message: warning.message };
    }),
    citations: [],
    ...rendered,
  });
}
