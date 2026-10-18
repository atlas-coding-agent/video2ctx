import { describe, expect, it, vi } from 'vitest';
import type { Comment } from 'all-things-youtube';
import type { EvidencePacket } from '../src/agents/contracts';
import type { AgentToolContext } from '../src/agents/providers/youtube/tool-context';
import type { YouTubeAgentProvider } from '../src/agents/providers/youtube/provider';
import { commentPageSlice, executeGetVideoComments } from '../src/agents/providers/youtube/tools/get-video-comments';
import { resolveTranscriptAnalystOutput } from '../src/agents/providers/youtube/transcript-analyst';
import { visualObservationText } from '../src/agents/providers/youtube/visual-provenance';
import { evidencePacketForModel, finalizationEvidenceForModel } from '../src/agents/runtime/model-evidence';
import { earlierTurnPacketIds } from '../src/agents/research/research-agent';

const VIDEO = 'abcdefghijk';

function comments(count: number): Comment[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `comment-${index + 1}`, author: { name: index === 11 ? 'Janine' : index === 13 ? 'Gale' : `Viewer ${index + 1}`, thumbnails: [] },
    text: `Comment number ${index + 1}.`, likeCount: 0, likeCountText: '0', replyCount: 0, isPinned: false, isHearted: false, replies: [],
  }) as unknown as Comment);
}

function commentContext(page: Comment[]) {
  const provider = {
    comments: vi.fn(async () => ({ cacheStatus: 'hit' as const, sessionReused: true, assetVersions: ['a'.repeat(64)],
      value: { videoId: VIDEO, totalCount: 40, comments: page, continuation: 'next-provider-page', replyContinuations: [],
        meta: { source: 'allthingsyoutube' as const, fetchedAt: new Date(0).toISOString(), partial: false, warnings: [] } } })),
  } as unknown as YouTubeAgentProvider;
  const keys: string[] = [];
  const context = {
    runId: 'run-1', provider, transcriptPolicy: { mode: 'complete_transcript' }, signal: new AbortController().signal,
    executeEvidenceTool: (execution: { semanticKey: string; execute: () => Promise<EvidencePacket> }) => { keys.push(execution.semanticKey); return execution.execute(); },
    finalize: vi.fn(),
  } as unknown as AgentToolContext;
  return { context, provider, keys };
}

describe('saved comment pages', () => {
  it('reports the page size and reaches every saved comment through offsets', async () => {
    const { context, provider, keys } = commentContext(comments(14));
    const first = await executeGetVideoComments({ videoId: VIDEO }, context, 'first');
    expect(first.excerpts).toHaveLength(12);
    expect(first.artifacts[0]!.data).toMatchObject({ returnedCount: 12, nextOffset: 12,
      collection: { fetchedCount: 14, retainedCount: 12, nextPageOffset: 12, morePages: true, continuationAccepted: true } });
    expect(first.warnings.map(warning => warning.code)).toContain('COMMENT_PAGE_REMAINING');
    const rest = await executeGetVideoComments({ videoId: VIDEO, offset: 12 }, context, 'rest');
    expect(rest.excerpts.map(excerpt => excerpt.id)).toEqual(['comment:comment-13:12', 'comment:comment-14:13']);
    expect(rest.excerpts[1]!.text).toContain('Author: Gale');
    expect(rest.artifacts[0]!.data).toMatchObject({ collection: { fetchedCount: 14, retainedCount: 2, pageOffset: 12 } });
    expect(rest.artifacts[0]!.data).not.toHaveProperty('nextOffset');
    // Saved-page offsets reread the same provider page, never the provider continuation.
    expect(provider.comments).toHaveBeenCalledWith(VIDEO, { continuation: undefined });
    expect(keys[0]).toBe(`comments:${JSON.stringify({ videoId: VIDEO })}`);
    expect(keys[1]).toBe(`comments:${JSON.stringify({ videoId: VIDEO, offset: 12 })}`);
  });

  it('keeps first-page excerpt IDs and the reuse key unchanged for offset 0', async () => {
    const { context, keys } = commentContext(comments(3));
    const packet = await executeGetVideoComments({ videoId: VIDEO, offset: 0 }, context, 'zero');
    expect(packet.excerpts.map(excerpt => excerpt.id)).toEqual(['comment:comment-1:0', 'comment:comment-2:1', 'comment:comment-3:2']);
    expect(keys).toEqual([`comments:${JSON.stringify({ videoId: VIDEO })}`]);
    expect(commentPageSlice(comments(3), 9)).toMatchObject({ page: [], start: 3 });
  });

  it('projects the current excerpt limit with honest counts and no silent cut', async () => {
    const { context } = commentContext(comments(14));
    const projected = evidencePacketForModel(await executeGetVideoComments({ videoId: VIDEO }, context, 'first'));
    expect(projected.excerpts).toHaveLength(8);
    expect(projected.collection).toMatchObject({ entriesShown: 8, entriesRetained: 12, entriesFetched: 14, entriesNotRetained: 2 });
    expect(projected.collection!.coverage).toContain('Read offset 12 with the same continuation');
    expect(projected.warnings.map(warning => warning.code)).toEqual(expect.arrayContaining(['COLLECTION_CONTEXT_TRUNCATED', 'COMMENT_PAGE_REMAINING']));
  });

  it('states unknown page size for legacy comment packets', () => {
    const legacy: EvidencePacket = { packetId: 'packet:legacy', kind: 'youtube_comments',
      sources: [{ id: 'c', provider: 'youtube', kind: 'comments', videoId: VIDEO }],
      excerpts: Array.from({ length: 10 }, (_, index) => ({ id: `comment:x:${index}`, sourceId: 'c', text: `Comment ${index}` })),
      artifacts: [{ type: 'youtube_comments', data: { returnedCount: 10 } }], warnings: [], usage: [] };
    const projected = evidencePacketForModel(legacy);
    expect(projected.excerpts).toHaveLength(8);
    expect(projected.collection!.coverage).toContain('was not recorded');
  });
});

describe('caption-level transcript citations', () => {
  const segment = (text: string, seconds: number) => ({ text, startMs: seconds * 1000, endMs: seconds * 1000 + 3000, durationMs: 3000 });
  const segments = [
    segment('Welcome back to the channel.', 0),
    segment('Today we are brewing pour over coffee.', 3),
    segment('Use 15 grams of coffee for 250 ml of water.', 52),
    segment('Some people use 115 grams for a big batch.', 56),
    segment('Stir gently and wait.', 70),
    segment('Stir gently and wait.', 80),
  ];
  const quantity = (quote: string) => ({ metric: 'dose', value: 15, unit: 'g', basis: null, kind: 'claimed', quote });
  const finding = (windowIndexes: number[], quantities: unknown[] = [], entities: unknown[] = []) =>
    ({ findings: [{ claim: 'A claim.', windowIndexes, quantities, entities, uncertainty: null }] });

  it('cites the caption cue that uniquely contains a quote', () => {
    const result = resolveTranscriptAnalystOutput(VIDEO, segments, finding([0], [quantity('Use 15 grams of coffee')]));
    expect(result.findings[0]!.excerptIds).toEqual([`transcript:${VIDEO}:2:52000:0`]);
    expect(result.excerpts).toEqual([{ id: `transcript:${VIDEO}:2:52000:0`, text: segments[2]!.text, startMs: 52000, endMs: 55000 }]);
  });

  it('keeps the window anchor for substring, repeated, translated and missing quotes', () => {
    const window0 = `transcript:${VIDEO}:window:0:0`;
    expect(resolveTranscriptAnalystOutput(VIDEO, segments, finding([0], [quantity('15 grams')])).findings[0]!.excerptIds).toEqual([window0]);
    expect(resolveTranscriptAnalystOutput(VIDEO, segments, finding([0, 1], [], [{ name: 'step', quote: 'Stir gently and wait.', source: 'transcript' }]))
      .findings[0]!.excerptIds).toEqual([window0, `transcript:${VIDEO}:window:1:70000`]);
    expect(resolveTranscriptAnalystOutput(VIDEO, segments, finding([0], [], [{ name: 'intro', quote: 'Bienvenue sur la chaîne', source: 'transcript' }]))
      .findings[0]!.excerptIds).toEqual([window0]);
    expect(resolveTranscriptAnalystOutput(VIDEO, segments, finding([0])).findings[0]!.excerptIds).toEqual([window0]);
  });

  it('cites every cue a quote spans, in the same IDs as raw transcript evidence', () => {
    const result = resolveTranscriptAnalystOutput(VIDEO, segments, finding([0], [quantity('pour over coffee. Use 15 grams')]));
    expect(result.findings[0]!.excerptIds).toEqual([`transcript:${VIDEO}:1:3000:0`, `transcript:${VIDEO}:2:52000:0`]);
    expect(result.coverage).toMatchObject({ completeTranscriptRead: true, segmentCount: 6, windowCount: 2 });
  });
});

describe('frame-specific visual provenance', () => {
  it('names the own frame for atomic observations and every frame for shared ones', () => {
    expect(visualObservationText('requested', 'White is ahead.', [65_000])).toBe('Visual observation at requested frame 1:05: White is ahead.');
    expect(visualObservationText('sampled', 'The board is set up.', [70_000, 10_000]))
      .toBe('Visual observation reported for each of the sampled frames at 0:10, 1:10: The board is set up.');
  });

  it('keeps identical observations at different frames as distinct evidence', () => {
    const excerpts = [10_000, 70_000].map((time, index) => ({ id: `frames:${VIDEO}:tool:${index}:${time}`, sourceId: 'f',
      text: visualObservationText('requested', 'Black to move.', [time]), startMs: time, endMs: time }));
    const packet: EvidencePacket = { packetId: 'packet:frames', kind: 'youtube_frames',
      sources: [{ id: 'f', provider: 'youtube', kind: 'frames', videoId: VIDEO }], excerpts,
      artifacts: [], warnings: [], usage: [] };
    expect(new Set(evidencePacketForModel(packet).excerpts!.map(excerpt => excerpt.text)).size).toBe(2);
  });
});

describe('delivered context disclosure', () => {
  const transcriptSource = { id: 's', provider: 'youtube' as const, kind: 'transcript' as const, videoId: VIDEO };
  const analysis = (packetId: string, findings: number): EvidencePacket => ({ packetId, kind: 'youtube_transcript', assetVersions: ['v1'],
    sources: [transcriptSource], excerpts: [{ id: `${packetId}:w`, sourceId: 's', text: 'Window', startMs: 0, endMs: 1000 }],
    artifacts: [{ type: 'youtube_transcript_analysis', data: { summary: 'Selected findings.', groundingVersion: 1,
      findings: Array.from({ length: findings }, (_, index) => ({ claim: `Claim ${index}`, excerptIds: [`${packetId}:w`], entities: [], quantities: [], uncertainty: null })),
      coverage: { completeTranscriptRead: true, segmentCount: 1, startMs: 0, endMs: 1000 }, selectedExcerptCount: 1 } }],
    warnings: [], usage: [] });

  it('states that analysis findings are not caption text, for old records too', () => {
    const projected = evidencePacketForModel(analysis('packet:old', 3));
    expect(projected.transcriptAnalysis!.delivery).toMatchObject({ findingsShown: 3, findingsSaved: 3, captionTextIncluded: false });
    expect(projected.transcriptAnalysis!.delivery!.note).toContain('do not claim to have read or reread the transcript');
  });

  it('labels packets from earlier turns without reporting a context cut', () => {
    const earlier = analysis('packet:run-0:tool', 2);
    const current = analysis('packet:run-1:tool', 2);
    const prepared = finalizationEvidenceForModel([earlier, current], 100_000, [], new Set(['packet:run-0:tool']));
    expect(prepared.evidence.map(packet => packet.delivery?.origin)).toEqual(['earlier_turn', 'this_turn']);
    expect(prepared.missingInputs).toEqual([]);
    expect(finalizationEvidenceForModel([current], 100_000).evidence[0]).not.toHaveProperty('delivery');
  });

  it('treats only history packets as earlier, never this run or its search hits', () => {
    const turn = { userMessageId: 'u', agentMessageId: 'a', user: 'q', assistant: 'a', resourceIds: [],
      evidence: [analysis('packet:run-0:tool', 1), analysis('search:x', 1)] };
    const ids = earlierTurnPacketIds([analysis('packet:run-0:tool', 1), analysis('packet:run-1:tool', 1), analysis('search:x', 1),
      { ...analysis('memory:abcdefghijk:1', 1), kind: 'youtube_video' }], [turn], 'run-1');
    expect([...ids]).toEqual(['packet:run-0:tool', 'memory:abcdefghijk:1']);
  });
});
