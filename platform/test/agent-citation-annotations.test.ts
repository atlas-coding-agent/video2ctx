import { describe, expect, it } from 'vitest';
import { blockReferences, renderStructuredAnswer } from '../src/agents/structured-answer';
import { buildAgentTurnResult } from '../src/agents/finalizer';
import { compactAgentResult } from '../src/agents/response';
import type { EvidencePacket } from '../src/agents/contracts';

const aliases = new Map(Array.from({ length: 202 }, (_, i) => [`ref_${i + 1}`, `e${i + 1}`]));
const base = { intent: 'context_answer' as const, confidence: 'medium' as const, artifacts: [], warnings: [] };
const render = (text: string, evidenceIds: string[] = [], references = aliases) =>
  renderStructuredAnswer({ ...base, blocks: [{ text, evidenceIds }] }, references);

// Minimal reproductions from the saved answers, with synthetic evidence below.
describe('citation regressions from reported sessions', () => {
  // Session 3e337336-961a-4a3c-9be3-76b66b95820f.
  it('strips watercolor annotations but preserves quoted speech and author names', () => {
    const text = 'The captions say "wait for a minute or two" (kelogsloops, ref_143, ref_144).\n\n'
      + 'Initial paper: Arches cold pressed (Anna, ref_30 to ref_36).';
    expect(render(text, ['ref_30']).answer).toBe('The captions say "wait for a minute or two" (kelogsloops).\n\n'
      + 'Initial paper: Arches cold pressed (Anna). [cite:e30]');
    expect(blockReferences({ text, evidenceIds: ['ref_30'] }, aliases)).toEqual(['e30']);
  });

  // Session 1c875330-dac3-4a5b-9acb-0123f23af6dc.
  it('keeps chess table citations while stripping ranges in surrounding prose', () => {
    const text = 'The general rule (ref_4 through ref_7, ref_33, ref_34).\n\n'
      + '| Observation | Source |\n| --- | --- |\n| Pawn moves | (ref_84) |\n\n'
      + 'Narrated examples (ref_62 through ref_65, ref_70, ref_72, ref_73 through ref_75).';
    expect(render(text, ['ref_4']).answer).toBe('The general rule.\n\n'
      + '| Observation | Source |\n| --- | --- |\n| Pawn moves | [cite:e84] |\n\n'
      + 'Narrated examples.\n\nSources: [cite:e4]');
    expect(blockReferences({ text, evidenceIds: ['ref_4'] }, aliases)).toEqual(['e4', 'e84']);
  });

  it('persists only array evidence for prose and keeps distinct passages reachable', () => {
    const packet: EvidencePacket = { packetId: 'session-fixture', kind: 'youtube_transcript',
      sources: [{ id: 'chess', provider: 'youtube', kind: 'transcript', videoId: 'DoGVxiU2VFI' }],
      excerpts: [
        { id: 'e4', sourceId: 'chess', text: 'Rule excerpt', startMs: 4000, endMs: 8000 },
        { id: 'e5', sourceId: 'chess', text: 'Undeclared excerpt', startMs: 6000, endMs: 10000 },
        { id: 'e66', sourceId: 'chess', text: 'Example excerpt', startMs: 136000, endMs: 141000 },
      ], artifacts: [], warnings: [], usage: [] };
    const result = buildAgentTurnResult({ runId: crypto.randomUUID(), conversationId: crypto.randomUUID(),
      userMessageId: crypto.randomUUID(), agentMessageId: crypto.randomUUID() },
    { userId: 'test', creditsRemaining: 10 }, render('Rule and example (ref_4 through ref_7, ref_66 to ref_70).', ['ref_4', 'ref_66']), [packet], 1);
    const compact = compactAgentResult(result, ['evidence']);
    expect(compact.answer).toBe('Rule and example. [1 · 0:04][1 · 2:16]');
    expect(result.citations.map(c => c.id)).toEqual(['e4', 'e66']);
    expect(compact.evidence?.map(c => c.id)).toEqual(['e4', 'e66']);
    expect(result.warnings).toEqual([]);
  });
});

describe('prose annotation removal', () => {
  it.each(['ref_4', '(ref_4, ref_7)', 'ref_4 through ref_7', 'ref_4 to 7', 'ref_4 thru ref_7',
    'ref_4-ref_7', 'ref_4–7', 'ref_4—7', '(ref_4 through ref_7)', '[ref_4 through ref_7]',
    '【ref_4 through ref_7】', '[ref_4]', '[cite:ref_4]', '[cite:e4]', '(source marker:e4]',
    'ref_404', '(ref_4, ref_404)', 'ref_7 to ref_4', 'ref_4 to ref_999999999999999999999',
    '[cite:untrusted marker payload]'])('strips %s without adding evidence', annotation => {
    expect(render(`Claim ${annotation}.`, ['ref_1']).answer).toBe('Claim. [cite:e1]');
    expect(blockReferences({ text: `Claim ${annotation}.`, evidenceIds: ['ref_1'] }, aliases)).toEqual(['e1']);
  });
  it('works without an alias map or any declared evidence', () => {
    expect(render('Claim (ref_4 through ref_7).', [], new Map()).answer).toBe('Claim.');
  });
  it('keeps citations scoped to their own blocks', () => {
    expect(renderStructuredAnswer({ ...base, blocks: [
      { text: 'First [cite:ref_2].', evidenceIds: ['ref_1'] },
      { text: 'Second.', evidenceIds: ['ref_2'] },
    ] }, aliases).answer).toBe('First. [cite:e1]\n\nSecond. [cite:e2]');
  });
  it.each([
    '`ref_4 through ref_7`', '```text\n(ref_4 to ref_7)\n```', '    ref_4 to ref_7',
    '[ref_4 through ref_7](https://example.com)', '[docs](https://example.com "ref_4 through ref_7")',
    '![frame (ref_4)](https://example.com/image.png)',
    'https://example.com/ref_4-ref_7', 'www.example.com/?q=ref_4',
    'fn(ref_4 through ref_7)', 'fn(value, ref_4)', 'outer(inner(ref_4), ref_7)',
    'fn("close)", ref_4)', 'fn(\n value, ref_4\n)',
    '"(ref_4 through ref_7)"', '“use ref_4 through ref_7 here”', '"use ref_4 here"',
    'my_ref_4', 'ref_4-based', 'ref_4.5', 'ref_4\'s',
  ])('preserves literal context: %s', text => {
    expect(render(text).answer).toBe(text);
    expect(blockReferences({ text, evidenceIds: [] }, aliases)).toEqual([]);
  });
  it('strips prose annotations beside protected literals', () => {
    expect(render('After fn(value, ref_4), see [docs](https://example.com/ref_7) (ref_4 through ref_7).', ['ref_1']).answer)
      .toBe('After fn(value, ref_4), see [docs](https://example.com/ref_7). [cite:e1]');
  });
});

describe('table citation boundaries', () => {
  it.each(['[cite:ref_4]', '[ref_4]', '(ref_4)', 'ref_4'])('retains explicit cell marker %s', marker => {
    const table = `| Claim | Source |\n| --- | --- |\n| Rule | ${marker} |`;
    expect(render(table).answer).toBe(table.replace(marker, '[cite:e4]'));
    expect(blockReferences({ text: table, evidenceIds: [] }, aliases)).toEqual(['e4']);
  });
  it('supports tables without outer pipes and with alignment markers', () => {
    const table = 'Claim | Source\n:--- | ---:\nRule | [cite:ref_4]';
    expect(render(table).answer).toBe(table.replace('[cite:ref_4]', '[cite:e4]'));
  });
  it('appends unplaced references below a table without outer pipes', () => {
    expect(render('Claim | Source\n--- | ---\nRule | [cite:ref_4]', ['ref_5']).answer)
      .toBe('Claim | Source\n--- | ---\nRule | [cite:e4]\n\nSources: [cite:e5]');
  });
  it('does not treat a pipe in prose as a table', () => {
    expect(render('Option A | Option B [cite:ref_4].', ['ref_1']).answer).toBe('Option A | Option B. [cite:e1]');
    expect(blockReferences({ text: 'Option A | Option B [cite:ref_4].', evidenceIds: [] }, aliases)).toEqual([]);
  });
  it('does not turn fenced table examples into citation-bearing cells', () => {
    const text = '```md\n| Claim | Source |\n| --- | --- |\n| Rule | [cite:ref_4] |\n```';
    expect(render(text).answer).toBe(text);
    expect(blockReferences({ text, evidenceIds: [] }, aliases)).toEqual([]);
  });
  it('does not expand ranges in table cells, and appends declared evidence below', () => {
    expect(render('| Claim | Source |\n| --- | --- |\n| Rule | ref_4 to ref_7 |', ['ref_4']).answer)
      .toBe('| Claim | Source |\n| --- | --- |\n| Rule | |\n\nSources: [cite:e4]');
  });
});

describe('PR review regressions', () => {
  it.each(['> ', '> > ', '- ', '  '])('preserves table citations in Markdown container %s', prefix => {
    const rows = ['| Claim | Source |', '| --- | --- |', '| A | [cite:ref_1] |', '| B | [cite:ref_2] |'];
    const text = rows.map((row, i) => (prefix === '- ' && i > 0 ? '  ' : prefix) + row).join('\n');
    expect(render(text).answer).toBe(text.trimStart().replace('[cite:ref_1]', '[cite:e1]').replace('[cite:ref_2]', '[cite:e2]'));
    expect(blockReferences({ text, evidenceIds: [] }, aliases)).toEqual(['e1', 'e2']);
  });

  it.each(['[docs](https://example.com)', '`example`'])('retains spacing after %s', literal => {
    expect(render(`See ${literal} (ref_1) for details.`, ['ref_1']).answer)
      .toBe(`See ${literal} for details. [cite:e1]`);
    expect(render(`${literal} (ref_1) (ref_2) for details.`).answer).toBe(`${literal} for details.`);
    expect(render(`See ${literal} (ref_1).`).answer).toBe(`See ${literal}.`);
    expect(render(`See ${literal} (ref_1) [more](https://example.com).`).answer)
      .toBe(`See ${literal} [more](https://example.com).`);
  });

  it('persists and displays both quoted-table citations without prose evidence', () => {
    const text = '> | Claim | Source |\n> | --- | --- |\n> | A | [cite:ref_1] |\n> | B | [cite:ref_2] |';
    const packet: EvidencePacket = { packetId: 'table-fixture', kind: 'youtube_transcript',
      sources: [{ id: 'source', provider: 'youtube', kind: 'transcript', videoId: 'abcdefghijk' }],
      excerpts: [
        { id: 'e1', sourceId: 'source', text: 'First passage', startMs: 1000, endMs: 2000 },
        { id: 'e2', sourceId: 'source', text: 'Second passage', startMs: 3000, endMs: 4000 },
      ], artifacts: [], warnings: [], usage: [] };
    const result = buildAgentTurnResult({ runId: crypto.randomUUID(), conversationId: crypto.randomUUID(),
      userMessageId: crypto.randomUUID(), agentMessageId: crypto.randomUUID() },
    { userId: 'test', creditsRemaining: 10 }, render(text), [packet], 1);
    expect(result.citations.map(c => c.id)).toEqual(['e1', 'e2']);
    expect(compactAgentResult(result, ['evidence']).answer)
      .toBe(text.replace('[cite:ref_1]', '[1 · 0:01]').replace('[cite:ref_2]', '[1 · 0:03]'));
  });

  const first = `evidence:${'a'.repeat(64)}:0`;
  const second = `evidence:${'b'.repeat(64)}:1`;
  it.each([
    `The notation is "[cite:${second}]".`,
    `The notation is “[cite:${second}]”.`,
    `The notation is \`[cite:${second}]\`.`,
    `See [literal [cite:${second}]](https://example.com).`,
    `Use fn([cite:${second}]).`,
    `See https://example.com/[cite:${second}].`,
  ])('keeps literal canonical markers out of persisted citations: %s', text => {
    const packet: EvidencePacket = { packetId: 'literal-fixture', kind: 'youtube_transcript',
      sources: [{ id: 'source', provider: 'youtube', kind: 'transcript', videoId: 'abcdefghijk' }],
      excerpts: [
        { id: first, sourceId: 'source', text: 'Declared evidence', startMs: 1000, endMs: 2000 },
        { id: second, sourceId: 'source', text: 'Undeclared evidence', startMs: 3000, endMs: 4000 },
      ], artifacts: [], warnings: [], usage: [] };
    expect(blockReferences({ text, evidenceIds: [first] })).toEqual([first]);
    const input = render(text, [first], new Map());
    for (const excerpts of [packet.excerpts, packet.excerpts.slice(0, 1)]) {
      const result = buildAgentTurnResult({ runId: crypto.randomUUID(), conversationId: crypto.randomUUID(),
        userMessageId: crypto.randomUUID(), agentMessageId: crypto.randomUUID() },
      { userId: 'test', creditsRemaining: 10 }, input, [{ ...packet, excerpts }], 1);
      expect(result.citations.map(c => c.id)).toEqual([first]);
      expect(result.warnings).toEqual([]);
      expect(compactAgentResult(result, ['evidence']).answer).toBe(`${text} [1 · 0:01]`);
    }
  });
});
