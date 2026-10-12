import type { PlaylistSummary, VideoSummary } from 'all-things-youtube';
import { describe, expect, it, vi } from 'vitest';
import type { EvidencePacket } from '../src/agents/contracts';
import type { YouTubeAgentProvider } from '../src/agents/providers/youtube/provider';
import type { AgentToolContext } from '../src/agents/providers/youtube/tool-context';
import { executeBrowseYouTube } from '../src/agents/providers/youtube/tools/browse-youtube';
import { executeGetChannelPlaylists } from '../src/agents/providers/youtube/tools/get-channel-playlists';
import { executeGetChannelVideos } from '../src/agents/providers/youtube/tools/get-channel-videos';
import { executeGetPlaylist } from '../src/agents/providers/youtube/tools/get-playlist';
import { executeSearchYouTube } from '../src/agents/providers/youtube/tools/search-youtube';
import {
  evidencePacketForModel,
  evidencePacketsForModel,
  finalizationEvidenceForModel,
  type ModelEvidencePacket,
} from '../src/agents/runtime/model-evidence';

describe('collection evidence projection (QA 027)', () => {
  it('shows all 12 retained playlist entries in projection and finalization', async () => {
    const packet = await playlistPacket({ videos: 12, videoCountText: '12 videos', videoCount: 12 });
    expect(packet.excerpts).toHaveLength(12);

    const projected = evidencePacketForModel(packet);
    expect(projected.excerpts).toHaveLength(12);
    expect(projected.sources).toHaveLength(12);
    expect(projected.collection).toMatchObject({
      entriesShown: 12, entriesRetained: 12, retainedEntriesNotShown: 0,
      entriesFetched: 12, entriesNotRetained: 0, reportedTotal: 12, morePages: false,
    });
    expect(projected.collection?.coverage).toContain('All 12 entries retained in this packet are shown.');
    // The raw provider videoCount has no provenance and is never projected.
    expect(JSON.stringify(projected)).not.toContain('videoCount');

    const { evidence, fullIds, omitted } = finalizationEvidenceForModel([packet], 40_000);
    expect(evidence[0]!.excerpts).toHaveLength(12);
    expect(JSON.stringify(evidence)).toContain('Chapter 12');
    expect(fullIds.size).toBe(12);
    expect(fullIds.get(evidence[0]!.excerpts![11]!.id)).toBe(packet.excerpts[11]!.id);
    expect(omitted).toEqual([]);
  });

  it('discloses 30 fetched, 12 retained, the stated total and a continuation that skips the page tail', async () => {
    const packet = await playlistPacket({ videos: 30, videoCountText: '45 videos', videoCount: 45, continuation: 'token-after-page' });
    expect(packet.excerpts).toHaveLength(12);
    expect(packet.artifacts[0]!.data.collection).toEqual({
      version: 1, fetchedCount: 30, retainedCount: 12, reportedTotal: 45, reportedTotalText: '45 videos',
      morePages: true, continuationAccepted: false,
    });

    const projected = evidencePacketForModel(packet);
    expect(projected.excerpts).toHaveLength(12);
    expect(projected.collection).toMatchObject({
      entriesShown: 12, entriesRetained: 12, entriesFetched: 30, entriesNotRetained: 18,
      reportedTotal: 45, reportedTotalText: '45 videos', morePages: true,
    });
    // get_playlist accepts no continuation, so the token is not offered as a path to more entries.
    expect(projected.continuation).toBeUndefined();
    expect(JSON.stringify(projected)).not.toContain('token-after-page');
    const coverage = projected.collection!.coverage;
    expect(coverage).toContain('The provider page had 30 entries.');
    expect(coverage).toContain('18 more were not retained because of the agent item limit');
    expect(coverage).toContain('cannot read further pages');
    expect(coverage).toContain('would not return the 18 unretained entries');
  });

  it('does not treat the provider fallback videoCount as a stated total', async () => {
    // all-things-youtube sets videoCount to the page length when the header states no count.
    const packet = await playlistPacket({ videos: 30, videoCount: 30 });
    expect(packet.artifacts[0]!.data.collection).not.toHaveProperty('reportedTotal');
    const projected = evidencePacketForModel(packet);
    expect(projected.collection).not.toHaveProperty('reportedTotal');
    expect(projected.collection!.coverage).toContain('No provider-stated total is available');
    expect(projected.collection!.entriesFetched).toBe(30);
  });

  it('keeps fetched counts unknown for packets saved before counts were recorded', async () => {
    const packet = await playlistPacket({ videos: 30, videoCountText: '45 videos', videoCount: 45, continuation: 'old-token' });
    const legacy = structuredClone(packet);
    delete legacy.artifacts[0]!.data.collection;

    const projected = evidencePacketForModel(legacy);
    expect(projected.excerpts).toHaveLength(12);
    expect(projected.collection).toEqual(expect.objectContaining({ entriesShown: 12, entriesRetained: 12, retainedEntriesNotShown: 0 }));
    for (const field of ['entriesFetched', 'entriesNotRetained', 'reportedTotal', 'morePages']) {
      expect(projected.collection).not.toHaveProperty(field);
    }
    expect(projected.collection!.coverage).toContain('was not recorded for this packet');
    expect(projected.continuation).toBeUndefined();
  });

  it('keeps an accepted continuation for channel videos and states that it skips the unretained tail', async () => {
    const provider = providerFixture();
    provider.channelVideos = vi.fn(async () => ({ cacheStatus: 'hit' as const,
      value: { channelId: 'channel-1', sort: 'latest' as const, videos: videos(30), continuation: 'next-page', meta: meta() } }));
    const packet = await executeGetChannelVideos({ channelId: 'channel-1', sort: 'latest' }, toolContext(provider), 'channel-videos');
    const projected = evidencePacketForModel(packet);
    expect(projected.excerpts).toHaveLength(12);
    expect(projected.continuation).toBe('next-page');
    expect(projected.collection).toMatchObject({ entriesFetched: 30, entriesNotRetained: 18, morePages: true });
    expect(projected.collection!.coverage).toContain('resumes after the whole fetched page');
    expect(projected.collection!.coverage).toContain('would not return the 18 unretained entries');
  });

  it('applies the same contract to search, browse and channel playlist lists', async () => {
    const provider = providerFixture();
    const tooLong = (index: number) => index < 5;
    provider.search = vi.fn(async () => ({ cacheStatus: 'hit' as const, value: {
      query: 'calculus', meta: meta(), videos: [], channels: [], playlists: [], continuation: 'search-next',
      results: videos(30).map((video, index) => ({ ...video, durationSeconds: tooLong(index) ? 10_000 : 600 })),
    } }));
    provider.browse = vi.fn(async () => ({ cacheStatus: 'hit' as const, value: {
      category: 'news', browseId: 'FEnews', title: 'News', results: videos(20), videos: [], channels: [], playlists: [], meta: meta(),
    } }));
    provider.channelPlaylists = vi.fn(async () => ({ cacheStatus: 'hit' as const, value: {
      channelId: 'channel-1', sort: 'newest' as const, playlists: Array.from({ length: 12 }, (_, index) => playlistSummary(index)), meta: meta(),
    } }));
    const context = { ...toolContext(provider), maxVideoSeconds: 3_600 };

    const search = evidencePacketForModel(await executeSearchYouTube({ query: 'calculus' }, context, 'search'));
    expect(search.excerpts).toHaveLength(12);
    expect(search.collection).toMatchObject({ entriesFetched: 30, entriesExcluded: 5, entriesRetained: 12, entriesNotRetained: 13, morePages: true });
    expect(search.collection!.coverage).toContain('5 were excluded by agent policy.');

    const browse = evidencePacketForModel(await executeBrowseYouTube({ category: 'news' }, context, 'browse'));
    expect(browse.excerpts).toHaveLength(12);
    expect(browse.collection).toMatchObject({ entriesFetched: 20, entriesNotRetained: 8, morePages: false });

    const playlists = evidencePacketForModel(await executeGetChannelPlaylists({ channelId: 'channel-1', sort: 'newest' }, context, 'playlists'));
    expect(playlists.excerpts).toHaveLength(12);
    expect(playlists.sources).toHaveLength(12);
    expect(playlists.collection).toMatchObject({ entriesShown: 12, entriesFetched: 12, entriesNotRetained: 0 });
  });

  it('recomputes shown and omitted counts after every budget reduction, and only visible entries are citable', async () => {
    const packet = await playlistPacket({ videos: 30, videoCountText: '45 videos', videoCount: 45, continuation: 'token', description: 'Worked examples. '.repeat(60) });
    const full = JSON.stringify([evidencePacketForModel(packet)]).length;
    let previous = 13;
    for (const budget of [full, full - 1, Math.floor(full / 2), Math.floor(full / 4), 2_500]) {
      const { evidence, fullIds, omitted } = finalizationEvidenceForModel([packet], budget);
      expect(JSON.stringify(evidence).length).toBeLessThanOrEqual(budget);
      expect(omitted).toEqual([]);
      const model = evidence[0]!;
      const shown = model.excerpts!.length;
      expect(shown).toBeLessThanOrEqual(previous);
      previous = shown;
      expect(model.collection).toMatchObject({
        entriesShown: shown, entriesRetained: 12, retainedEntriesNotShown: 12 - shown,
        entriesFetched: 30, entriesNotRetained: 18, reportedTotal: 45,
      });
      assertCitable(model, fullIds, packet);
      if (shown < 12) {
        expect(model.collection!.coverage).toContain(shown ? `Only entries 1 to ${shown} of the 12 retained` : 'None of the 12 retained');
        expect(model.warnings).toContainEqual(expect.objectContaining({ code: 'COLLECTION_CONTEXT_TRUNCATED' }));
      } else {
        expect(model.warnings).not.toContainEqual(expect.objectContaining({ code: 'COLLECTION_CONTEXT_TRUNCATED' }));
      }
    }
    expect(previous).toBeLessThan(12);
    expect(previous).toBeGreaterThan(0);
  });

  it('shortens entry text before dropping entries', async () => {
    const packet = await playlistPacket({ videos: 12, videoCountText: '12 videos', videoCount: 12, description: 'Long chapter description. '.repeat(60) });
    const full = JSON.stringify([evidencePacketForModel(packet)]).length;
    const [model] = evidencePacketsForModel([packet], { maxCharacters: Math.floor(full * 0.75) });
    expect(model!.excerpts).toHaveLength(12);
    expect(model!.excerpts!.every(excerpt => excerpt.text.length < 800)).toBe(true);
    expect(model!.collection!.entriesShown).toBe(12);
  });

  it('reports a packet that cannot fit at all instead of dropping it silently, and never exceeds tiny budgets', async () => {
    const packet = await playlistPacket({ videos: 12, videoCountText: '12 videos', videoCount: 12 });
    const zero = finalizationEvidenceForModel([packet], 0);
    expect(zero.evidence).toEqual([]);
    expect(zero.fullIds.size).toBe(0);
    expect(zero.omitted).toEqual([expect.objectContaining({
      packetId: packet.packetId, kind: 'youtube_playlist', title: 'Calculus course', entriesRetained: 12, reason: 'context_budget',
    })]);

    let budget = 0;
    let first: ReturnType<typeof finalizationEvidenceForModel> | undefined;
    for (; budget <= 20_000; budget += 25) {
      const prepared = finalizationEvidenceForModel([packet], budget);
      expect(JSON.stringify(prepared.evidence).length).toBeLessThanOrEqual(budget);
      if (prepared.evidence.length) { first = prepared; break; }
      expect(prepared.omitted).toHaveLength(1);
    }
    // The smallest budget that fits shows counts with no entries, sources or citable IDs.
    const model = first!.evidence[0]!;
    expect(first!.omitted).toEqual([]);
    expect(model.collection).toMatchObject({ entriesShown: model.excerpts!.length, entriesRetained: 12 });
    expect(model.excerpts!.length).toBeLessThan(12);
    assertCitable(model, first!.fullIds, packet);
    if (model.excerpts!.length === 0) {
      expect(model.sources).toEqual([]);
      expect(model.collection!.coverage).toContain('None of the 12 retained entries fit this context.');
    }
  });

  it('leaves non-list projections unchanged', () => {
    const video: EvidencePacket = {
      packetId: 'packet:video', kind: 'youtube_video',
      sources: [{ id: 'source:video', provider: 'youtube', kind: 'video', videoId: 'abcdefghijk' }],
      excerpts: Array.from({ length: 10 }, (_, index) => ({ id: `video:${index}`, sourceId: 'source:video', text: `Fact ${index}` })),
      artifacts: [{ type: 'youtube_video', data: {} }], warnings: [], usage: [],
    };
    const comments: EvidencePacket = { ...video, packetId: 'packet:comments', kind: 'youtube_comments',
      sources: [{ id: 'source:comments', provider: 'youtube', kind: 'comments', videoId: 'abcdefghijk' }],
      excerpts: video.excerpts.map(excerpt => ({ ...excerpt, sourceId: 'source:comments' })),
      artifacts: [{ type: 'youtube_comments', data: {} }] };
    for (const packet of [video, comments]) {
      const projected = evidencePacketForModel(packet);
      expect(projected.excerpts).toHaveLength(8);
      expect(projected).not.toHaveProperty('collection');
    }
  });
});

function assertCitable(model: ModelEvidencePacket, fullIds: Map<string, string>, packet: EvidencePacket) {
  const visible = model.excerpts!.map(excerpt => excerpt.id);
  expect([...fullIds.keys()].sort()).toEqual([...visible].sort());
  const sourceIds = new Set(model.sources.map(source => source.id));
  expect(sourceIds).toEqual(new Set(model.excerpts!.map(excerpt => excerpt.sourceId)));
  for (const id of visible) {
    const excerpt = packet.excerpts.find(candidate => candidate.id === fullIds.get(id));
    expect(excerpt).toBeDefined();
    expect(sourceIds.has(excerpt!.sourceId)).toBe(true);
  }
}

async function playlistPacket(options: {
  videos: number; videoCount?: number; videoCountText?: string; continuation?: string; description?: string;
}): Promise<EvidencePacket> {
  const provider = providerFixture();
  provider.playlist = vi.fn(async () => ({ cacheStatus: 'hit' as const, value: {
    ...playlistSummary(0), title: 'Calculus course', videoCount: options.videoCount, videoCountText: options.videoCountText,
    videos: videos(options.videos, options.description), continuation: options.continuation, meta: meta(),
  } }));
  return executeGetPlaylist({ playlistId: 'PLcalculus' }, toolContext(provider), 'playlist-call');
}

function videos(count: number, description = 'A worked calculus lesson.'): VideoSummary[] {
  return Array.from({ length: count }, (_, index) => ({
    type: 'video' as const,
    id: `v${String(index + 1).padStart(10, '0')}`,
    title: `Chapter ${index + 1}: Lesson ${index + 1}`,
    description,
    channel: { id: 'channel-1', name: 'Calculus Channel', url: 'https://www.youtube.com/channel/channel-1' },
    thumbnails: [],
    durationSeconds: 600,
    durationText: '10:00',
    isLive: false,
    hasCaptions: true,
    url: `https://www.youtube.com/watch?v=v${String(index + 1).padStart(10, '0')}`,
  }));
}

function playlistSummary(index: number): PlaylistSummary {
  return {
    type: 'playlist', id: `PLcalculus${index}`, title: `Playlist ${index + 1}`, thumbnails: [], isPodcast: false,
    url: `https://www.youtube.com/playlist?list=PLcalculus${index}`,
  };
}

function providerFixture(): YouTubeAgentProvider {
  const unexpected = (name: string) => vi.fn(async () => { throw new Error(`Unexpected ${name} call.`); });
  return {
    search: unexpected('search'), browse: unexpected('browse'), trends: unexpected('trends'), video: unexpected('video'),
    tracks: unexpected('tracks'), transcript: unexpected('transcript'), comments: unexpected('comments'),
    endscreen: unexpected('endscreen'), channel: unexpected('channel'), channelVideos: unexpected('channelVideos'),
    channelPlaylists: unexpected('channelPlaylists'), playlist: unexpected('playlist'),
  } as unknown as YouTubeAgentProvider;
}

function toolContext(provider: YouTubeAgentProvider): AgentToolContext {
  return {
    runId: 'run-collection',
    provider,
    transcriptPolicy: { mode: 'complete_transcript' },
    signal: new AbortController().signal,
    executeEvidenceTool: (execution) => execution.execute(),
    finalize: vi.fn(async () => { throw new Error('Unexpected finalization.'); }),
  };
}

function meta() {
  return { source: 'allthingsyoutube' as const, fetchedAt: new Date().toISOString(), partial: false, warnings: [] };
}
