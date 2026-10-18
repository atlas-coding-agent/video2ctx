import { describe, expect, it } from 'vitest';
import { metadataForConversation, unambiguousMetadataRecords } from '../src/agents/runtime/conversation-metadata';
import type { AgentCitation, EvidencePacket } from '../src/agents/contracts';
import {
  boundConversationHistory,
  citedEvidenceForConversation,
  conversationModelMessages,
  resolveConversationHistory,
  type LinkedConversationTurn,
  type ConversationTurn,
} from '../src/agents/runtime/conversation-memory';

describe('YouTube agent conversation memory', () => {
  it('retains prior metadata with its observation time', () => {
    const metadata = metadataForConversation([{ recordedAt: 1000, packet: {
      packetId: 'prior-video', kind: 'youtube_video',
      sources: [{ id: 'video', kind: 'video', provider: 'youtube', videoId: 'abcdefghijk', title: 'Video' }],
      excerpts: [], artifacts: [{ type: 'youtube_video_metadata', data: { id: 'abcdefghijk', viewCount: 404433 } }],
      warnings: [], usage: [],
    } as EvidencePacket }]);
    const history = [{ ...turn('summarize', 'A summary without a view count.'), metadata }];
    expect(JSON.stringify(conversationModelMessages(history, 'How many views?'))).toContain('404433');
    expect(JSON.stringify(conversationModelMessages(history, 'How many views?'))).toContain('1970-01-01T00:00:01.000Z');
    expect(boundConversationHistory(history)).toEqual(history);
  });

  it('keeps a single-turn request free of invented history', () => {
    expect(conversationModelMessages([], 'Inspect this video')).toEqual([
      { role: 'user', content: 'Inspect this video' },
    ]);
  });

  it('passes completed turns to the model in chronological role order', () => {
    const history = [
      turn('first-user', 'first-assistant'),
      turn('second-user', 'second-assistant'),
    ];

    expect(conversationModelMessages(history, 'follow-up')).toEqual([
      { role: 'user', content: 'first-user' },
      { role: 'assistant', content: 'first-assistant' },
      { role: 'user', content: 'second-user' },
      { role: 'assistant', content: 'second-assistant' },
      { role: 'user', content: 'follow-up' },
    ]);
  });

  it('selects the newest ancestors within the turn limit', () => {
    const newestFirst = [
      turn('newest-user', 'newest-assistant'),
      turn('middle-user', 'middle-assistant'),
      turn('oldest-user', 'oldest-assistant'),
    ];

    expect(boundConversationHistory(newestFirst, { maxTurns: 2 }))
      .toEqual([newestFirst[1], newestFirst[0]]);
  });

  it('keeps eight complete turns even when history exceeds 64,000 characters', () => {
    const newestFirst = Array.from({ length: 10 }, (_, index) =>
      turn(`user-${index}`, `${index}:` + 'x'.repeat(65_000)));
    expect(boundConversationHistory(newestFirst)).toEqual(newestFirst.slice(0, 8).reverse());
    const records = newestFirst.map((entry, index) => ({ ...entry,
      parentMessageId: newestFirst[index + 1]?.agentMessageId ?? null }));
    const byId = new Map(records.map(entry => [entry.agentMessageId, entry]));
    expect(resolveConversationHistory(records[0]!.agentMessageId, id => byId.get(id)))
      .toEqual({ ok: true, history: records.slice(0, 8).reverse() });
  });

  it('keeps sibling conversation branches isolated', () => {
    const firstBranch = [turn('topic A', 'answer A')];
    const secondBranch = [turn('topic B', 'answer B')];

    expect(JSON.stringify(conversationModelMessages(firstBranch, 'continue'))).not.toContain('topic B');
    expect(JSON.stringify(conversationModelMessages(secondBranch, 'continue'))).not.toContain('topic A');
  });

  it('reconstructs only the selected parent chain', () => {
    const root = linkedTurn('root', 'root-answer', null);
    const branchA = linkedTurn('branch-a', 'answer-a', root.agentMessageId);
    const branchB = linkedTurn('branch-b', 'answer-b', root.agentMessageId);
    const records = new Map([root, branchA, branchB].map((record) => [record.agentMessageId, record]));

    const resolution = resolveConversationHistory(
      branchA.agentMessageId,
      (messageId) => records.get(messageId),
    );

    expect(resolution).toMatchObject({ ok: true });
    if (!resolution.ok) throw new Error('Expected a complete branch.');
    expect(resolution.history.map((entry) => entry.user)).toEqual(['root', 'branch-a']);
    expect(JSON.stringify(resolution.history)).not.toContain('branch-b');
  });

  it('rejects unavailable and cyclic parent chains', () => {
    expect(resolveConversationHistory('missing', () => undefined)).toEqual({
      ok: false,
      issue: 'unavailable',
      messageId: 'missing',
    });

    const cycle = linkedTurn('cycle', 'cycle-answer', 'cycle-id');
    cycle.agentMessageId = 'cycle-id';
    expect(resolveConversationHistory('cycle-id', () => cycle)).toEqual({
      ok: false,
      issue: 'cycle',
      messageId: 'cycle-id',
    });
  });

  it('attaches recovered evidence only to the current request', () => {
    const messages = conversationModelMessages(
      [turn('prior-user', 'prior-assistant')],
      'current-user',
      [{ packetId: 'packet-1' }],
    );

    expect(messages[1]).toEqual({ role: 'assistant', content: 'prior-assistant' });
    expect(JSON.stringify(messages[2])).toContain('current-user');
    expect(JSON.stringify(messages[2])).toContain('packet-1');
  });
});

describe('cited evidence lineage', () => {
  const source = { id: 'youtube:abcdefghijk:transcript', provider: 'youtube' as const, kind: 'transcript' as const,
    videoId: 'abcdefghijk', url: 'https://www.youtube.com/watch?v=abcdefghijk' };
  const packet = (packetId: string, excerpts: Array<{ id: string; text: string; startMs?: number }>, assetVersions?: string[]): EvidencePacket => ({
    packetId, kind: 'youtube_transcript', sources: [source], assetVersions,
    excerpts: excerpts.map(excerpt => ({ ...excerpt, sourceId: source.id })), artifacts: [{ type: 'note', data: { private: 'uncited' } }], warnings: [], usage: [],
  });
  const cite = (excerpt: { id: string; text: string; startMs?: number; endMs?: number }): AgentCitation => ({ id: excerpt.id, sourceId: source.id,
    provider: 'youtube', videoId: source.videoId, url: source.url, excerpt: excerpt.text, startMs: excerpt.startMs,
    endMs: excerpt.endMs, sourceKind: 'transcript' });

  it('keeps delivered packet scope but restores only cited excerpts from a saved fallback', () => {
    const delivered = packet('packet:run-1:tool', [{ id: 'a', text: 'Cited line', startMs: 1000 }, { id: 'b', text: 'Uncited line' }], ['v1']);
    const saved = packet('session:v2:0:30:hash', [{ id: 'c', text: 'Search hit', startMs: 2000 }, { id: 'd', text: 'Neighbour' }], ['v2']);
    const restored = citedEvidenceForConversation([cite(delivered.excerpts[0]!), cite(saved.excerpts[0]!)], [delivered], [saved]);
    expect(restored.map(item => item.packetId)).toEqual(['packet:run-1:tool', 'session:v2:0:30:hash']);
    expect(restored[0]!.excerpts.map(item => item.id)).toEqual(['a', 'b']);
    expect(restored[1]).toMatchObject({ excerpts: [{ id: 'c' }], artifacts: [] });
    // An admitted packet that the turn never cited is not lineage.
    expect(citedEvidenceForConversation([cite(saved.excerpts[0]!)], [delivered], [saved]).map(item => item.packetId))
      .toEqual(['session:v2:0:30:hash']);
  });

  it('rejects legacy ID collisions across saved versions', () => {
    const excerpt = { id: 'transcript:abcdefghijk:0:0:0', text: 'Same caption', startMs: 0 };
    const first = packet('session:v1:0:30:hash', [excerpt], ['v1']);
    const second = packet('session:v2:0:30:hash', [excerpt], ['v2']);
    expect(citedEvidenceForConversation([cite(excerpt)], [], [first, second])).toEqual([]);
    expect(citedEvidenceForConversation([cite(excerpt)], [], [first]).map(item => item.packetId)).toEqual(['session:v1:0:30:hash']);
  });

  it('requires exact source, text and timestamps rather than an excerpt ID alone', () => {
    const saved = packet('session:v1:0:30:hash', [{ id: 'a', text: 'Original caption', startMs: 1000 }], ['v1']);
    const citation = cite(saved.excerpts[0]!);
    expect(citedEvidenceForConversation([{ ...citation, excerpt: 'Edited caption' }], [], [saved])).toEqual([]);
    expect(citedEvidenceForConversation([{ ...citation, startMs: 2000 }], [], [saved])).toEqual([]);
    expect(citedEvidenceForConversation([{ ...citation, videoId: 'zyxwvutsrqp' }], [], [saved])).toEqual([]);
    expect(citedEvidenceForConversation([citation], [], [saved])).toHaveLength(1);
  });

  it('copies superseded warnings without mutating stored packets', () => {
    const delivered = packet('packet:run-1:tool', [{ id: 'a', text: 'Old caption', startMs: 0 }], ['v1']);
    const saved = { ...delivered, warnings: [{ code: 'SUPERSEDED_SESSION_EVIDENCE', message: 'Older version.' }] };
    const restored = citedEvidenceForConversation([cite(delivered.excerpts[0]!)], [delivered], [saved]);
    expect(restored[0]!.warnings.map(item => item.code)).toEqual(['SUPERSEDED_SESSION_EVIDENCE']);
    expect(delivered.warnings).toEqual([]);
  });

  it('reconstructs only delivered metadata snapshots and rejects conflicting observations', () => {
    const video = (viewCount: number, packetId: string): EvidencePacket => ({ packetId, kind: 'youtube_video',
      sources: [{ id: 'video', provider: 'youtube', kind: 'video', videoId: 'abcdefghijk', title: 'Video' }], excerpts: [],
      artifacts: [{ type: 'youtube_video_metadata', data: { id: 'abcdefghijk', viewCount } }], warnings: [], usage: [] });
    const one = { packet: video(10, 'packet:a'), recordedAt: 2000 };
    const conflicting = { packet: video(20, 'packet:b'), recordedAt: 2000 };
    const other = { packet: video(30, 'packet:c'), recordedAt: 3000 };
    expect(unambiguousMetadataRecords([one, other], new Set(['memory:abcdefghijk:2000']))).toEqual([one]);
    expect(unambiguousMetadataRecords([one, conflicting], new Set(['memory:abcdefghijk:2000']))).toEqual([]);
  });
});

function turn(user: string, assistant: string): ConversationTurn {
  return {
    userMessageId: crypto.randomUUID(),
    agentMessageId: crypto.randomUUID(),
    user,
    assistant,
    resourceIds: [],
  };
}

function linkedTurn(user: string, assistant: string, parentMessageId: string | null): LinkedConversationTurn {
  return { ...turn(user, assistant), parentMessageId };
}
