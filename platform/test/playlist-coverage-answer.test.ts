import { describe, expect, it } from 'vitest';
import type { EvidencePacket, FinalizeAnswerInput } from '../src/agents/contracts';
import { buildAgentTurnResult } from '../src/agents/finalizer';
import { collectionRetrieval } from '../src/agents/runtime/collection-coverage';

const identity = { runId: crypto.randomUUID(), conversationId: crypto.randomUUID(), userMessageId: crypto.randomUUID(), agentMessageId: crypto.randomUUID() };
const admission = { userId: 'user', creditsRemaining: 100 };
const videoId = (index: number) => `v${String(index + 1).padStart(10, '0')}`;

function playlist(collection?: Record<string, unknown>, options: { packetId?: string; continuation?: string; retained?: number } = {}): EvidencePacket {
  const retained = options.retained ?? 12;
  return {
    packetId: options.packetId ?? 'packet:playlist', kind: 'youtube_playlist',
    sources: Array.from({ length: retained }, (_, index) => ({ id: `youtube:playlist:PLcalc:${videoId(index)}:${index}`,
      provider: 'youtube' as const, kind: 'playlist' as const, playlistId: 'PLcalc', videoId: videoId(index), title: `Chapter ${index + 1}` })),
    excerpts: Array.from({ length: retained }, (_, index) => ({ id: `playlist:call:${index}`,
      sourceId: `youtube:playlist:PLcalc:${videoId(index)}:${index}`, text: `Chapter ${index + 1}\nDuration: 45:00` })),
    // videoCount is the provider value, which falls back to the page length. It must never be disclosed as a total.
    artifacts: [{ type: 'youtube_playlist', title: 'Calculus course', data: { videoCount: 30, ...(collection ? { collection } : {}) } }],
    continuation: options.continuation, warnings: [], usage: [],
  };
}

function transcript(index: number): EvidencePacket {
  return { packetId: `packet:transcript:${index}`, kind: 'youtube_transcript',
    sources: [{ id: `transcript:${videoId(index)}`, provider: 'youtube', kind: 'transcript', videoId: videoId(index) }],
    excerpts: [{ id: `caption:${index}`, sourceId: `transcript:${videoId(index)}`, text: 'The fundamental theorem links derivatives and integrals.' }],
    artifacts: [], warnings: [], usage: [] };
}

function answer(citations: string[], intent: FinalizeAnswerInput['intent'] = 'topic_research'): FinalizeAnswerInput {
  return { answer: `Chapter 12 covers the fundamental theorem. ${citations.map(id => `[cite:${id}]`).join('')}`, intent, confidence: 'medium',
    citations: [], artifacts: [], warnings: [] };
}

const result = (packets: EvidencePacket[], citations: string[]) => buildAgentTurnResult(identity, admission, answer(citations), packets, 0);

describe('playlist coverage disclosure in final responses', () => {
  it('QA 027: states the provider total, the 12-video listing limit, and the one video whose content was reviewed', () => {
    const packets = [playlist(collectionRetrieval({ fetchedCount: 30, retainedCount: 12, reportedTotal: 45, reportedTotalText: '45 videos',
      continuation: 'next', continuationAccepted: false })), transcript(11)];
    const response = result(packets, ['playlist:call:11', 'caption:11']);
    expect(response.answer).toContain('**Playlist coverage (Calculus course):** This playlist has 45 videos in total. Listing details were available for 12 because video2ctx lists at most 12 videos per playlist, so coverage of this playlist is incomplete.');
    expect(response.answer).toContain('Transcript or visual content was reviewed for 1 of the 12 listed videos; the other 11 are known only from listing details (title, description, duration).');
    expect(response.answer.startsWith('Chapter 12 covers the fundamental theorem.')).toBe(true);
    expect(response.artifacts).toContainEqual({ type: 'playlist_coverage', title: 'Calculus course', data: {
      playlistId: 'PLcalc', coverage: 'incomplete', listLimit: 12, listedVideos: 12, reviewedVideos: 1, fetchedVideos: 30, reportedTotal: 45 } });
    expect(response.citations.map(citation => citation.id)).toEqual(['playlist:call:11', 'caption:11']);
  });

  it('keeps an unreported total unknown and blames the listing limit only when the page had more entries', () => {
    const response = result([playlist(collectionRetrieval({ fetchedCount: 30, retainedCount: 12, continuationAccepted: false }))], ['playlist:call:0']);
    expect(response.answer).toContain("The playlist's total number of videos was not reported. The listing returned 30 videos, but details were available for only 12 because video2ctx lists at most 12 videos per playlist, so coverage of this playlist is incomplete.");
    expect(response.answer).toContain('No transcript or visual content was reviewed for these videos, so statements about them rely on listing details (title, description, duration) only.');
    expect(response.answer).not.toContain('in total');

    const complete = result([playlist(collectionRetrieval({ fetchedCount: 5, retainedCount: 5, continuationAccepted: false }), { retained: 5 })], ['playlist:call:0']);
    expect(complete.answer).toContain("The playlist's total number of videos was not reported. The listing returned 5 videos with no further videos.");
    expect(complete.answer).not.toMatch(/incomplete|at most 12/);
  });

  it('reports a complete playlist when the stated total equals the listed entries', () => {
    const response = result([playlist(collectionRetrieval({ fetchedCount: 12, retainedCount: 12, reportedTotal: 12, reportedTotalText: '12 videos', continuationAccepted: false })),
      ...Array.from({ length: 12 }, (_, index) => transcript(index))], ['playlist:call:0']);
    expect(response.answer).toContain('This playlist has 12 videos in total, and listing details were available for all 12.');
    expect(response.answer).toContain('Transcript or visual content was reviewed for all 12 listed videos.');
    expect(response.answer).not.toContain('incomplete');
  });

  it('keeps the total unknown for a saved playlist without recorded counts and never uses its videoCount', () => {
    const response = result([playlist(undefined, { continuation: 'old-token' })], ['playlist:call:3']);
    expect(response.answer).toContain("The playlist's total number of videos is unknown for this saved listing. Listing details are available for 12 videos, and video2ctx lists at most 12 videos per playlist, so coverage of this playlist may be incomplete.");
    expect(response.answer).not.toContain('30');
    expect(response.artifacts).toContainEqual(expect.objectContaining({ type: 'playlist_coverage', data: expect.objectContaining({ coverage: 'unknown' }) }));
    expect(response.artifacts.find(artifact => artifact.type === 'playlist_coverage')!.data).not.toHaveProperty('reportedTotal');
  });

  it('discloses a playlist when the answer cites only reviewed content for one of its videos', () => {
    const response = result([playlist(collectionRetrieval({ fetchedCount: 30, retainedCount: 12, reportedTotal: 45, continuationAccepted: false })), transcript(11)], ['caption:11']);
    expect(response.answer).toContain('This playlist has 45 videos in total.');
    expect(response.answer).toContain('reviewed for 1 of the 12 listed videos');
  });

  it('adds nothing when the answer does not rely on the playlist', () => {
    const unrelated = { ...transcript(0), packetId: 'packet:other', sources: [{ id: 'transcript:other', provider: 'youtube' as const, kind: 'transcript' as const, videoId: 'zzzzzzzzzzz' }],
      excerpts: [{ id: 'caption:other', sourceId: 'transcript:other', text: 'Unrelated.' }] };
    const input = answer(['caption:other']);
    const response = buildAgentTurnResult(identity, admission, input, [playlist(collectionRetrieval({ fetchedCount: 30, retainedCount: 12, continuationAccepted: false })), unrelated], 0);
    expect(response.answer).toBe(input.answer);
    expect(response.artifacts.some(artifact => artifact.type === 'playlist_coverage')).toBe(false);
  });

  it('writes one note per playlist, prefers recorded counts, and does not repeat an existing note', () => {
    const recorded = playlist(collectionRetrieval({ fetchedCount: 30, retainedCount: 12, reportedTotal: 45, continuationAccepted: false }), { packetId: 'packet:new' });
    const legacy = playlist(undefined, { packetId: 'packet:old' });
    const first = result([legacy, recorded], ['playlist:call:0']);
    expect(first.answer.match(/\*\*Playlist coverage/g)).toHaveLength(1);
    expect(first.answer).toContain('This playlist has 45 videos in total.');
    const again = buildAgentTurnResult(identity, admission, { ...answer([]), answer: first.answer }, [legacy, recorded], 0);
    expect(again.answer).toBe(first.answer);
  });
});
