import type { AgentArtifact, EvidencePacket } from './contracts';
import { COLLECTION_ITEM_LIMIT, readCollectionRetrieval } from './runtime/collection-coverage';

/** Packets whose excerpts are reviewed video content, as opposed to listing metadata. */
const REVIEWED_CONTENT_KINDS = new Set<EvidencePacket['kind']>(['youtube_transcript', 'youtube_storyboard', 'youtube_frames']);
const MAX_DISCLOSED_PLAYLISTS = 3;

export type PlaylistCoverage = 'complete' | 'incomplete' | 'unknown';

/**
 * Application-written coverage notes for the playlists an answer relies on.
 * A playlist counts as relied on when the answer cites one of its entries, or
 * cites any evidence about a video it lists.
 *
 * The total comes only from a provider-stated count recorded at retrieval.
 * Saved playlists without recorded counts keep an unknown total. Listing
 * details (title, description, duration) are kept apart from videos whose
 * transcript or visual content was reviewed.
 */
export function playlistCoverageDisclosures(
  packets: readonly EvidencePacket[],
  citedExcerptIds: readonly string[],
): { notes: string[]; artifacts: AgentArtifact[] } {
  const cited = new Set(citedExcerptIds);
  const citedVideos = new Set(packets.flatMap(packet => packet.excerpts.filter(excerpt => cited.has(excerpt.id))
    .flatMap(excerpt => packet.sources.find(source => source.id === excerpt.sourceId)?.videoId ?? [])));
  const reviewed = new Set(packets.filter(packet => REVIEWED_CONTENT_KINDS.has(packet.kind))
    .flatMap(packet => packet.excerpts.filter(excerpt => excerpt.text.trim())
      .flatMap(excerpt => packet.sources.find(source => source.id === excerpt.sourceId)?.videoId ?? [])));

  // One disclosure per playlist. A packet with recorded counts is preferred over a legacy copy.
  const playlists = new Map<string, EvidencePacket>();
  for (const packet of packets) {
    if (packet.kind !== 'youtube_playlist') continue;
    const relied = packet.excerpts.some(excerpt => cited.has(excerpt.id))
      || packet.sources.some(source => source.videoId && citedVideos.has(source.videoId));
    if (!relied) continue;
    const id = packet.sources.find(source => source.playlistId)?.playlistId ?? packet.packetId;
    const existing = playlists.get(id);
    if (!existing || (!readCollectionRetrieval(existing) && readCollectionRetrieval(packet))) playlists.set(id, packet);
  }

  const disclosed = [...playlists.entries()];
  const notes: string[] = [];
  const artifacts: AgentArtifact[] = [];
  for (const [playlistId, packet] of disclosed.slice(0, MAX_DISCLOSED_PLAYLISTS)) {
    const disclosure = playlistDisclosure(packet, reviewed);
    notes.push(disclosure.note);
    artifacts.push({ type: 'playlist_coverage', title: disclosure.title, data: { playlistId, ...disclosure.data } });
  }
  if (disclosed.length > MAX_DISCLOSED_PLAYLISTS) {
    const more = disclosed.length - MAX_DISCLOSED_PLAYLISTS;
    notes.push(`Coverage notes for ${more} more playlist${more === 1 ? '' : 's'} are not shown. Treat their coverage as possibly incomplete.`);
  }
  return { notes, artifacts };
}

function playlistDisclosure(packet: EvidencePacket, reviewedVideos: ReadonlySet<string>) {
  const retrieval = readCollectionRetrieval(packet);
  const recorded = retrieval && retrieval.retainedCount === packet.excerpts.length ? retrieval : undefined;
  const retained = packet.excerpts.length;
  const videoIds = [...new Set(packet.sources.flatMap(source => source.videoId ?? []))];
  const reviewed = videoIds.filter(videoId => reviewedVideos.has(videoId)).length;
  const title = (packet.artifacts.find(artifact => artifact.type === 'youtube_playlist')?.title ?? 'this playlist')
    .replace(/\s+/g, ' ').replace(/\*/g, '').trim().slice(0, 120) || 'this playlist';
  const limit = `video2ctx lists at most ${COLLECTION_ITEM_LIMIT} videos per playlist`;
  const listed = `${retained} video${retained === 1 ? '' : 's'}`;
  const sentences: string[] = [];
  let coverage: PlaylistCoverage;

  if (recorded?.reportedTotal !== undefined) {
    const total = recorded.reportedTotal;
    if (total > retained) {
      coverage = 'incomplete';
      const cause = recorded.fetchedCount > retained ? ` because ${limit}` : ` because the playlist listing returned only ${retained}`;
      sentences.push(`This playlist has ${total} videos in total. Listing details were available for ${retained}${cause}, so coverage of this playlist is incomplete.`);
    } else {
      coverage = 'complete';
      sentences.push(`This playlist has ${total} video${total === 1 ? '' : 's'} in total, and listing details were available for ${total === retained ? `all ${retained}` : listed}.`);
    }
  } else if (recorded) {
    if (recorded.fetchedCount > retained) {
      coverage = 'incomplete';
      sentences.push(`The playlist's total number of videos was not reported. The listing returned ${recorded.fetchedCount} videos, but details were available for only ${retained} because ${limit}, so coverage of this playlist is incomplete.`);
    } else if (recorded.morePages) {
      coverage = 'incomplete';
      sentences.push(`The playlist's total number of videos was not reported. Listing details were available for ${listed}, and the playlist has further videos that were not listed (${limit}), so coverage of this playlist is incomplete.`);
    } else {
      coverage = 'complete';
      sentences.push(`The playlist's total number of videos was not reported. The listing returned ${listed} with no further videos.`);
    }
  } else {
    coverage = 'unknown';
    sentences.push(retained >= COLLECTION_ITEM_LIMIT || packet.continuation
      ? `The playlist's total number of videos is unknown for this saved listing. Listing details are available for ${listed}, and ${limit}, so coverage of this playlist may be incomplete.`
      : `The playlist's total number of videos is unknown for this saved listing. Listing details are available for ${listed}.`);
  }

  const known = 'listing details (title, description, duration)';
  sentences.push(reviewed === 0
    ? `No transcript or visual content was reviewed for these videos, so statements about them rely on ${known} only.`
    : reviewed === videoIds.length
      ? `Transcript or visual content was reviewed for all ${videoIds.length} listed videos.`
      : `Transcript or visual content was reviewed for ${reviewed} of the ${videoIds.length} listed videos; the other ${videoIds.length - reviewed} are known only from ${known}.`);

  return {
    title,
    note: `**Playlist coverage (${title}):** ${sentences.join(' ')}`,
    data: {
      coverage,
      listLimit: COLLECTION_ITEM_LIMIT,
      listedVideos: retained,
      reviewedVideos: reviewed,
      ...(recorded ? { fetchedVideos: recorded.fetchedCount } : {}),
      ...(recorded?.reportedTotal !== undefined ? { reportedTotal: recorded.reportedTotal } : {}),
    },
  };
}
