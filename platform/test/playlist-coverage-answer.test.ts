import { describe, expect, it } from 'vitest';
import type { EvidencePacket, FinalizeAnswerInput } from '../src/agents/contracts';
import { buildAgentTurnResult } from '../src/agents/finalizer';
import { openCodeFence } from '../src/agents/playlist-coverage';
import { collectionRetrieval } from '../src/agents/runtime/collection-coverage';

const identity = { runId: crypto.randomUUID(), conversationId: crypto.randomUUID(), userMessageId: crypto.randomUUID(), agentMessageId: crypto.randomUUID() };
const admission = { userId: 'user', creditsRemaining: 100 };
const videoId = (index: number) => `v${String(index + 1).padStart(10, '0')}`;

function playlist(collection?: Record<string, unknown>, options: {
  packetId?: string; continuation?: string; retained?: number; playlistId?: string; title?: string; call?: string;
} = {}): EvidencePacket {
  const retained = options.retained ?? 12;
  const playlistId = options.playlistId ?? 'PLcalc';
  const call = options.call ?? 'call';
  return {
    packetId: options.packetId ?? `packet:${playlistId}`, kind: 'youtube_playlist',
    sources: Array.from({ length: retained }, (_, index) => ({ id: `youtube:playlist:${playlistId}:${videoId(index)}:${index}`,
      provider: 'youtube' as const, kind: 'playlist' as const, playlistId, videoId: videoId(index), title: `Chapter ${index + 1}` })),
    excerpts: Array.from({ length: retained }, (_, index) => ({ id: `playlist:${call}:${index}`,
      sourceId: `youtube:playlist:${playlistId}:${videoId(index)}:${index}`, text: `Chapter ${index + 1}\nDuration: 45:00` })),
    // videoCount is the provider value, which falls back to the page length. It must never be disclosed as a total.
    artifacts: [{ type: 'youtube_playlist', title: options.title ?? 'Calculus course', data: { videoCount: 30, ...(collection ? { collection } : {}) } }],
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
      playlistId: 'PLcalc', coverage: 'incomplete', listLimit: 12, listedVideos: 12, reviewedVideos: 1, fetchedVideos: 30, reportedTotal: 45, cited: 'entry' } });
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
    expect(response.answer).toContain("The playlist's total number of videos is unknown for this saved listing. Listing details are available for 12 videos, so coverage of this playlist may be incomplete. video2ctx lists at most 12 videos per playlist.");
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

  it('review: states the limit separately when the provider page itself had only 12 entries', () => {
    const response = result([playlist(collectionRetrieval({ fetchedCount: 12, retainedCount: 12, reportedTotal: 45, continuationAccepted: false }))], ['playlist:call:0']);
    expect(response.answer).toContain('This playlist has 45 videos in total. Listing details were available for 12, so coverage of this playlist is incomplete. The playlist listing returned 12 videos, and video2ctx lists at most 12 videos per playlist.');
    // The limit did not cut this page, so it is not named as the cause.
    expect(response.answer).not.toContain('because video2ctx');
  });

  it('review: places the notice outside an unclosed code fence and leaves the code unchanged', () => {
    const packets = [playlist(collectionRetrieval({ fetchedCount: 30, retainedCount: 12, reportedTotal: 45, continuationAccepted: false }))];
    for (const [code, fence] of [
      ['```python\nderivative = sympy.diff(f, x)\n```js not a close\n', '```'],
      ['~~~~\nprint(1)\n~~~\nstill code', '~~~~'],
      ['  ````md\n```\nnested fence text', '````'],
    ] as const) {
      const input = { ...answer(['playlist:call:11']), answer: `Chapter 12 covers the fundamental theorem. [cite:playlist:call:11]\n\n${code}` };
      expect(openCodeFence(input.answer)).toBe(fence);
      const response = buildAgentTurnResult(identity, admission, input, packets, 0);
      expect(response.answer.startsWith(input.answer)).toBe(true);
      const tail = response.answer.slice(input.answer.length);
      expect(tail.startsWith(`${input.answer.endsWith('\n') ? '' : '\n'}${fence}\n\n**Playlist coverage (Calculus course):**`)).toBe(true);
      expect(openCodeFence(response.answer)).toBeUndefined();
    }
    // Closed, indented and inline fences are not open.
    expect(openCodeFence('```\ncode\n```\n')).toBeUndefined();
    expect(openCodeFence('    ```\nindented code block')).toBeUndefined();
    expect(openCodeFence('```js `x` ```')).toBeUndefined();
    const closed = buildAgentTurnResult(identity, admission, { ...answer(['playlist:call:0']), answer: 'Text [cite:playlist:call:0]\n\n```\ncode\n```' }, packets, 0);
    expect(closed.answer).toMatch(/^Text \[cite:playlist:call:0\]\n\n```\ncode\n```\n\n\*\*Playlist coverage/);
  });

  it('review: citing one playlist entry does not pull in other playlists that share the video', () => {
    const playlists = [1, 2, 3, 4].map(index => playlist(collectionRetrieval({ fetchedCount: 30, retainedCount: 12, reportedTotal: index === 4 ? 97 : 20 + index, continuationAccepted: false }),
      { playlistId: `PL${index}`, title: `Playlist ${index}`, call: `pl${index}` }));
    const response = result(playlists, ['playlist:pl4:0']);
    expect(response.answer).toContain('**Playlist coverage (Playlist 4):** This playlist has 97 videos in total.');
    expect(response.answer).not.toMatch(/Playlist [123]/);
    expect(response.artifacts.filter(artifact => artifact.type === 'playlist_coverage').map(artifact => artifact.data.playlistId)).toEqual(['PL4']);
  });

  it('review: puts directly cited playlists first and keeps the exact total of every cited playlist', () => {
    const totals = [21, 22, 23, 97, 55];
    const playlists = totals.map((total, index) => playlist(collectionRetrieval({ fetchedCount: 30, retainedCount: 12, reportedTotal: total, continuationAccepted: false }),
      { playlistId: `PL${index + 1}`, title: `Playlist ${index + 1}`, call: `pl${index + 1}` }));
    // Reviewed content for a shared video is cited first; it makes PL5 relied on only through that content.
    const content = transcript(0);
    const response = result([...playlists, content],
      ['caption:0', 'playlist:pl1:0', 'playlist:pl2:1', 'playlist:pl3:2', 'playlist:pl4:3']);
    const notes = response.answer.split('\n\n').filter(part => part.startsWith('**'));
    expect(notes.slice(0, 3).map(note => /\(Playlist (\d)\)/.exec(note)?.[1])).toEqual(['1', '2', '3']);
    // The fourth directly cited playlist and the content-only playlist keep exact totals in the compact line.
    expect(notes[3]).toMatch(/^\*\*Other playlist coverage:\*\* Playlist 4: 97 videos in total, listing details for 12, content reviewed for 1 \(incomplete\); Playlist 5: 55 videos in total/);
    expect(notes[3]).toContain('video2ctx lists at most 12 videos per playlist.');
    const artifacts = response.artifacts.filter(artifact => artifact.type === 'playlist_coverage');
    expect(artifacts.map(artifact => [artifact.data.playlistId, artifact.data.reportedTotal, artifact.data.cited])).toEqual([
      ['PL1', 21, 'entry'], ['PL2', 22, 'entry'], ['PL3', 23, 'entry'], ['PL4', 97, 'entry'], ['PL5', 55, 'video_content']]);
  });
});
