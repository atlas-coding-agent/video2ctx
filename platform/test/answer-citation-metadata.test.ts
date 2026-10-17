import { afterEach, describe, expect, it, vi } from 'vitest';
import * as markdown from '../src/agents/markdown-citations';
import { citedEvidenceIds, citationMarkers, rewriteAnswerCitations, removeAnswerCitations, insertAnswerText } from '../src/agents/answer-citations';
import { renderStructuredAnswer, contextFinalizationOutputSchema } from '../src/agents/structured-answer';
import { buildAgentTurnResult } from '../src/agents/finalizer';
import { compactAgentResult, legacyAgentRun, publicAgentTurnResultSchema } from '../src/agents/response';
import { withDurationLimitNotice } from '../src/agents/research/duration-limit-answer';
import { answerNoticeInsertion } from '../src/agents/playlist-coverage';
import { evidenceFallback } from '../src/agents/research/evidence-fallback';
import { agentTurnResultSchema, type EvidencePacket, type FinalizeAnswerInput } from '../src/agents/contracts';
import type { AgentRunView } from '../src/agents/agent-runtime-do';

const first = `evidence:${'a'.repeat(64)}:0`;
const second = `evidence:${'b'.repeat(64)}:1`;
const packet: EvidencePacket = { packetId: 'metadata', kind: 'youtube_transcript',
  sources: [{ id: 'source', provider: 'youtube', kind: 'transcript', videoId: 'abcdefghijk' }],
  excerpts: [
    { id: first, sourceId: 'source', text: 'First finding', startMs: 1000, endMs: 2000 },
    { id: second, sourceId: 'source', text: 'Second finding', startMs: 3000, endMs: 4000 },
  ], artifacts: [], warnings: [], usage: [] };
const base = { intent: 'context_answer' as const, confidence: 'high' as const, artifacts: [], warnings: [] };
const render = (blocks: { text: string; evidenceIds: string[] }[]) => renderStructuredAnswer({ ...base, blocks });
const finalize = (input: FinalizeAnswerInput) => buildAgentTurnResult({ runId: crypto.randomUUID(),
  conversationId: crypto.randomUUID(), userMessageId: crypto.randomUUID(), agentMessageId: crypto.randomUUID() },
{ userId: 'test', creditsRemaining: 10 }, input, [packet], 1);
afterEach(() => vi.restoreAllMocks());

function prohibitDiscovery() {
  vi.spyOn(markdown, 'answerCitationIds').mockImplementation(() => { throw new Error('New answers must not rediscover evidence'); });
  vi.spyOn(markdown, 'mapCitationText').mockImplementation(() => { throw new Error('New answers must not rediscover citation positions'); });
}

describe('application-owned citation metadata', () => {
  it('finalizes and displays unfinished literals without text-based discovery', () => {
    prohibitDiscovery();
    const text = `An example: fn([cite:${second}],`;
    const input = render([{ text, evidenceIds: [first] }]);
    expect(citedEvidenceIds(input)).toEqual([first]);
    expect(input.citationGroups).toEqual([{ start: text.length + 1,
      end: input.answer.length, evidenceIds: [first] }]);
    const result = agentTurnResultSchema.parse(JSON.parse(JSON.stringify(finalize(input))));
    expect(result.citations.map(c => c.id)).toEqual([first]);
    expect(compactAgentResult(result).answer).toBe(`${text} [1 · 0:01]`);
    const deleted = rewriteAnswerCitations(result, () => ({ text: '[source deleted]', evidenceIds: [] }));
    expect(deleted).toEqual({ answer: `${text} [source deleted]`, citationGroups: [] });
  });

  it('uses a table block array without requiring row annotations', () => {
    prohibitDiscovery();
    const table = '| Video | Finding |\n| --- | --- |\n| First | A |\n| Second | B |';
    const input = render([{ text: table, evidenceIds: [first, second] }]);
    expect(compactAgentResult(finalize(input)).answer).toBe(`${table}\n\nSources: [1 · 0:01][1 · 0:03]`);
  });

  it('treats empty metadata as authoritative even when text contains a real marker', () => {
    prohibitDiscovery();
    const input = { ...base, citations: [], answer: `Literal [cite:${second}]`, citationGroups: [] };
    const result = finalize(input);
    expect(result.citations).toEqual([]);
    expect(compactAgentResult(result)).toMatchObject({ answer: input.answer, sources: [] });
  });

  it('preserves offsets across notices, emoji, unresolved sources, and later blocks', () => {
    prohibitDiscovery();
    const input = withDurationLimitNotice(render([
      { text: '🔎 First finding.', evidenceIds: ['missing', first] },
      { text: `A literal "[cite:${first}]".`, evidenceIds: [second] },
    ]), 'A required notice.');
    const result = finalize(input);
    expect(result.citations.map(c => c.id)).toEqual([first, second]);
    expect(compactAgentResult(result).answer).toBe(`A required notice.\n\n🔎 First finding. [1 · 0:01] [source unavailable]\n\nA literal "[cite:${first}]". [1 · 0:03]`);
    for (const group of result.citationGroups!) expect(result.answer.slice(group.start, group.end)).toBe(citationMarkers(group.evidenceIds));
    const deleted = rewriteAnswerCitations(result, ids => ({ text: ids.includes(first) ? '[source deleted]' : citationMarkers(ids),
      evidenceIds: ids.includes(first) ? [] : ids }));
    expect(compactAgentResult({ ...result, ...deleted, citations: result.citations.filter(c => c.id !== first) }).answer)
      .toBe(`A required notice.\n\n🔎 First finding. [source deleted] [source unavailable]\n\nA literal "[cite:${first}]". [1 · 0:03]`);
  });

  it('carries metadata for application fallback findings as well', () => {
    prohibitDiscovery();
    const input = evidenceFallback([{ ...packet, artifacts: [{ type: 'youtube_transcript_analysis', data: {
      findings: [{ claim: 'An unfinished example: fn(', excerptIds: [first] }],
    } }] }], 'topic_research')!;
    expect(citedEvidenceIds(input)).toEqual([first]);
    expect(compactAgentResult(finalize(input)).answer).toContain('An unfinished example: fn( [1 · 0:01]');
  });

  it('updates later positions when one source in a block is deleted', () => {
    prohibitDiscovery();
    const result = finalize(render([{ text: 'Both findings.', evidenceIds: [first, second] },
      { text: 'Second again.', evidenceIds: [second] }]));
    const removed = removeAnswerCitations(result, new Set([first]), '[source deleted]');
    const saved = { ...result, ...removed, citations: result.citations.filter(c => c.id !== first) };
    expect(citedEvidenceIds(saved)).toEqual([second]);
    expect(compactAgentResult(saved).answer).toBe('Both findings. [1 · 0:03] [source deleted]\n\nSecond again. [1 · 0:03]');
    expect(removeAnswerCitations(saved, new Set([first]), '[source deleted]')).toEqual(removed);
  });

  it('tracks coverage notices inserted before an absorbing code block', () => {
    prohibitDiscovery();
    const input = render([{ text: 'First.', evidenceIds: [first] },
      { text: '```\nAn unfinished code sample', evidenceIds: [] },
      { text: 'Second.', evidenceIds: [second] }]);
    const insertion = answerNoticeInsertion(input.answer, ['Coverage notice.'])!;
    expect(insertion.at).toBeLessThan(input.citationGroups![1]!.start);
    const updated = { ...input, ...insertAnswerText(input, insertion) };
    for (const group of updated.citationGroups!) expect(updated.answer.slice(group.start, group.end)).toBe(citationMarkers(group.evidenceIds));
    expect(compactAgentResult(finalize(updated)).answer).toContain('First. [1 · 0:01]\n\nCoverage notice.');
    expect(compactAgentResult(finalize(updated)).answer).toContain('Second. [1 · 0:03]');
  });

  it('omits application metadata from model schemas and public responses', () => {
    const input = render([{ text: 'A finding.', evidenceIds: [first] }]);
    const modelOutput = contextFinalizationOutputSchema.parse({ ...base, blocks: [{ text: 'A finding.', evidenceIds: [first] }], citationGroups: input.citationGroups });
    expect(modelOutput).not.toHaveProperty('citationGroups');
    const result = finalize(input);
    expect(compactAgentResult(result)).not.toHaveProperty('citationGroups');
    expect(publicAgentTurnResultSchema.parse({ ...result, sessionId: result.conversationId })).not.toHaveProperty('citationGroups');
    expect(legacyAgentRun({ result, conversationId: result.conversationId } as AgentRunView).result).not.toHaveProperty('citationGroups');
  });

  it('rejects stale or overlapping application positions instead of reparsing', () => {
    const input = render([{ text: 'A finding.', evidenceIds: [first] }]);
    expect(() => finalize({ ...input, answer: 'Changed ' + input.answer })).toThrow('Invalid application citation locations');
    expect(() => finalize({ ...input, citationGroups: [...input.citationGroups!, ...input.citationGroups!] })).toThrow('Invalid application citation locations');
  });

  it('keeps legacy persisted answers readable when metadata is absent', () => {
    const result = finalize({ ...base, citations: [], answer: `Legacy. [cite:${first}]` });
    expect(result).not.toHaveProperty('citationGroups');
    expect(compactAgentResult(result).answer).toBe('Legacy. [1 · 0:01]');
  });
});
