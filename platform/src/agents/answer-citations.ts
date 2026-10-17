import type { AnswerCitationGroup } from './contracts';
import { answerCitationIds, mapCitationText, endsInCodeBlock, tableRanges } from './markdown-citations';

type CitedAnswer = { answer: string; citationGroups?: AnswerCitationGroup[] };
export const citationMarkers = (ids: readonly string[]) => ids.map(id => `[cite:${id}]`).join(' ');

/** New answers carry authority directly. Parsing is only for stored legacy answers. */
export function citedEvidenceIds(value: CitedAnswer): string[] {
  return value.citationGroups === undefined ? answerCitationIds(value.answer)
    : [...new Set(value.citationGroups.flatMap(group => group.evidenceIds))];
}

/** Replace application-owned locations and update offsets. Retained IDs must form
 * canonical markers at the start of replacement text; notices may follow them. */
export function rewriteAnswerCitations(value: CitedAnswer,
  transform: (ids: string[]) => { text: string; evidenceIds: string[] }): CitedAnswer {
  if (value.citationGroups === undefined) {
    return { answer: mapCitationText(value.answer, prose => prose.replace(
      /\[cite:[A-Za-z0-9:_-]+\](?:[ \t]*\[cite:[A-Za-z0-9:_-]+\])*/g,
      group => transform([...group.matchAll(/\[cite:([A-Za-z0-9:_-]+)\]/g)].map(match => match[1]!)).text)) };
  }
  let answer = '', cursor = 0;
  const citationGroups: AnswerCitationGroup[] = [];
  for (const group of value.citationGroups) {
    if (group.start < cursor || group.end > value.answer.length || group.end <= group.start
      || value.answer.slice(group.start, group.end) !== citationMarkers(group.evidenceIds)) {
      throw new Error('Invalid application citation locations.');
    }
    answer += value.answer.slice(cursor, group.start);
    const replacement = transform(group.evidenceIds);
    const start = answer.length;
    if (replacement.evidenceIds.length && !replacement.text.startsWith(citationMarkers(replacement.evidenceIds)))
      throw new Error('Retained citations must precede replacement notices.');
    answer += replacement.text;
    if (replacement.evidenceIds.length) citationGroups.push({ start, end: start + citationMarkers(replacement.evidenceIds).length, evidenceIds: replacement.evidenceIds });
    cursor = group.end;
  }
  return { answer: answer + value.answer.slice(cursor), citationGroups };
}

/** Render known block references and record their locations at insertion time. */
export function renderCitedBlocks(blocks: readonly { text: string; evidenceIds: readonly string[] }[]): CitedAnswer & { citationGroups: AnswerCitationGroup[] } {
  let answer = '';
  const citationGroups: AnswerCitationGroup[] = [];
  for (const block of blocks) {
    if (answer) answer += '\n\n';
    const text = block.text;
    const evidenceIds = [...new Set(block.evidenceIds)];
    if (!evidenceIds.length) { answer += text; continue; }
    const markers = citationMarkers(evidenceIds);
    // Code-ending blocks need their sources before the code. Tables
    // get a separate paragraph; citation authority never depends on parsing it.
    const before = endsInCodeBlock(text);
    const separate = tableRanges(text).length > 0;
    const prefix = before ? 'Sources: ' : `${text}${separate ? '\n\nSources: ' : ' '}`;
    answer += prefix;
    const start = answer.length;
    answer += markers;
    citationGroups.push({ start, end: answer.length, evidenceIds });
    if (before) answer += `\n\n${text}`;
  }
  return { answer, citationGroups };
}

/** Insert application notices without losing citation positions. */
export function insertAnswerText(value: CitedAnswer, insertion: { at: number; text: string } | null): CitedAnswer {
  if (!insertion) return value;
  const { at, text } = insertion;
  if (at < 0 || at > value.answer.length || value.citationGroups?.some(group => at > group.start && at < group.end))
    throw new Error('Cannot insert text inside an application citation.');
  return { answer: value.answer.slice(0, at) + text + value.answer.slice(at),
    ...(value.citationGroups !== undefined ? { citationGroups: value.citationGroups.map(group => group.start >= at
      ? { ...group, start: group.start + text.length, end: group.end + text.length } : group) } : {}) };
}

/** Keep unavailable/deleted evidence visibly marked without retaining its authority. */
export function removeAnswerCitations(value: CitedAnswer, removed: ReadonlySet<string>, notice: string): CitedAnswer {
  return rewriteAnswerCitations(value, ids => {
    const remaining = ids.filter(id => !removed.has(id));
    const text = value.citationGroups === undefined
      ? ids.map(id => removed.has(id) ? notice : citationMarkers([id])).join(' ')
      : [citationMarkers(remaining), ...ids.filter(id => removed.has(id)).map(() => notice)].filter(Boolean).join(' ');
    return { text, evidenceIds: remaining };
  });
}
