import { fail, ok, type Bytes, type ToolResult } from '@/features/registry/types';

import {
  CODECS,
  detectContainer,
  refuseUnknownContainer,
  type SourceFile,
  type SourceTrack,
} from './containers';
import { readIsoBmff } from './isobmff';
import { readMatroska } from './matroska';
import { buildSampleEntry, mediaSize, writeMp4, type OutputTrack } from './mp4writer';

/**
 * TURNING ONE CONTAINER INTO ANOTHER, AND SAYING WHAT THAT COST.
 *
 * The conversion itself is short, because the two readers and the writer have
 * already done the work. What lives here is the part that decides WHICH
 * streams travel, and - the longer half - the part that says out loud what did
 * not.
 *
 * That second half is the whole lesson of the image tool. A converter that
 * hands back a plausible file is believed, and every silent change it made is
 * a change nobody will ever find out about: an animation flattened to a still,
 * transparency matted onto white, a photograph's GPS coordinates removed. The
 * equivalents here are a subtitle track that did not fit in an MP4, a second
 * language dropped, and - the one that matters most in an application whose
 * whole pitch is that your data does not move - THE LOCATION AND THE DATE THE
 * VIDEO WAS RECORDED, which a phone writes into the file and a repackage
 * silently leaves behind.
 *
 * So every one of those is a note on the result, and the ones that change what
 * you have are repeated in the summary line, because a caveat nobody scrolls
 * to has not been said.
 */

export type Operation = 'container' | 'audio';

export interface RemuxNote {
  readonly level: 'info' | 'warn' | 'hint';
  readonly title: string;
  readonly body: string;
}

export interface StreamFacts {
  readonly format: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly duration: string | null;
  readonly frames: number | null;
  readonly bytes: number;
  readonly metadata: readonly string[];
}

export interface RemuxOutcome {
  readonly bytes: Bytes;
  readonly mediaType: string;
  readonly extension: string;
  readonly from: StreamFacts;
  readonly to: StreamFacts;
  readonly notes: readonly RemuxNote[];
}

/* ========================================================================== *
 * Vocabulary
 * ========================================================================== */

/**
 * Keyed on the output's EXTENSION rather than on the container, because `.m4a`
 * and `.mp4` are the same container and are not the same answer to "what did I
 * just get". A music player and a video player are different applications.
 */
const CONTAINER_NAMES: Readonly<Record<string, string>> = {
  mp4: 'MP4',
  m4a: 'M4A',
  mp3: 'MP3',
  matroska: 'Matroska',
};

/** `1:02:03`, `2:07`, `0:04`. The way a player writes it, not a number of ms. */
export function formatDuration(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return null;
  const whole = Math.round(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = whole % 60;
  const padded = `${minutes.toString().padStart(hours > 0 ? 2 : 1, '0')}:${rest.toString().padStart(2, '0')}`;
  return hours > 0 ? `${String(hours)}:${padded}` : padded;
}

/** `Matroska · H.264 + AAC`, which is the whole story of a repackage in a row. */
function describeStreams(container: string, tracks: readonly SourceTrack[]): string {
  const names = tracks.map((track) => CODECS[track.codec].label);
  const label = CONTAINER_NAMES[container] ?? container;
  return names.length === 0 ? label : `${label} · ${names.join(' + ')}`;
}

function trackSeconds(track: SourceTrack): number | null {
  const samples = track.samples;
  if (samples.count === 0 || track.timescale <= 0) return null;
  const end = (samples.dts[samples.count - 1] ?? 0) + samples.lastDuration;
  return end / track.timescale;
}

/* ========================================================================== *
 * Choosing what travels
 * ========================================================================== */

interface Selection {
  readonly kept: readonly SourceTrack[];
  readonly dropped: readonly SourceTrack[];
}

/**
 * One video stream and one audio stream, which is a decision rather than a
 * limitation of the writer.
 *
 * A film ripped to Matroska routinely carries five audio dubs and a dozen
 * subtitle tracks, and an MP4 can hold several audio tracks perfectly well.
 * What it cannot do is let a person CHOOSE between them - almost no player
 * offers a track menu for an MP4, and the ones that do pick the first anyway.
 * A repackage that carried all five would produce a file five times the size
 * whose extra tracks nobody can reach.
 *
 * So the first of each kind travels and the rest are named in the notes, which
 * is the honest version of the same decision: the user finds out that their
 * file had a French dub in it and that this tool did not bring it.
 */
function selectTracks(file: SourceFile, operation: Operation): Selection {
  const kept: SourceTrack[] = [];
  const dropped: SourceTrack[] = [];

  const wanted = (track: SourceTrack): boolean =>
    operation === 'audio' ? track.kind === 'audio' : track.kind !== 'other';

  for (const track of file.tracks) {
    const carried = CODECS[track.codec].carried;
    const takenAlready = kept.some((existing) => existing.kind === track.kind);
    if (wanted(track) && carried && !takenAlready) kept.push(track);
    else dropped.push(track);
  }

  return { kept, dropped };
}

/** Why nothing could travel, said in terms of what the file actually holds. */
function refuseSelection<T>(file: SourceFile, operation: Operation): ToolResult<T> {
  const streams = file.tracks
    .filter((track) => track.kind !== 'other')
    .map(
      (track) => `${track.kind === 'video' ? 'video' : 'audio'} is ${CODECS[track.codec].label}`,
    );

  if (operation === 'audio') {
    const audio = file.tracks.filter((track) => track.kind === 'audio');
    if (audio.length === 0) {
      return fail('invalid-input', 'That file has no audio in it.', {
        detail: 'There is nothing to extract. Repackaging the container is the other option here.',
      });
    }
    return fail('unsupported-type', 'That file’s audio cannot be extracted without re-encoding.', {
      detail: `${audio.map((track) => CODECS[track.codec].label).join(' and ')}. ${
        CODECS[audio[0]?.codec ?? 'unknown'].refusal ?? ''
      } This version copies the audio out untouched or not at all.`,
    });
  }

  return fail('unsupported-type', 'Nothing in that file can be repackaged as MP4.', {
    detail:
      streams.length === 0
        ? 'It holds no video and no audio - only tracks an MP4 has no place for, such as subtitles.'
        : `Its ${streams.join(' and its ')}. A container change cannot convert a codec, and this version does not re-encode: it copies the frames across untouched or it refuses. If the file is a WebM, it already plays in Chrome, Firefox and Edge.`,
  });
}

/* ========================================================================== *
 * Metadata, which is the part a repackage silently discards
 * ========================================================================== */

function metadataNote(found: readonly string[]): RemuxNote | null {
  if (found.length === 0) return null;
  return {
    level: 'warn',
    title: `${found.join(', ')} removed`,
    body: 'A repackage rebuilds the index and carries only the streams. Everything the recording device wrote alongside them is left behind, which is a privacy improvement and is also information you may have wanted.',
  };
}

/* ========================================================================== *
 * The conversion
 * ========================================================================== */

/**
 * A file this tool will not produce, however the input asks for it.
 *
 * Sample ranges are allowed to overlap - nothing in either container forbids
 * two frames from pointing at the same bytes - so a small file can describe an
 * enormous one. A five megabyte file declaring a million samples of sixty
 * kilobytes each, all pointing at the same place, asks for sixty gigabytes,
 * and every individual range in it is inside the file and passes every other
 * check here.
 *
 * The bound is the input's own size, because a repackage COPIES: it cannot
 * honestly produce meaningfully more media than it was given. Doubling plus a
 * megabyte covers the index and any real file's overlap, and refuses the shape
 * above with three orders of magnitude to spare.
 */
function outputCeiling(inputBytes: number): number {
  return inputBytes * 2 + 1024 * 1024;
}

function toOutputTrack(track: SourceTrack): OutputTrack | null {
  const sampleEntry =
    track.sampleEntry ??
    buildSampleEntry({
      codec: track.codec,
      width: track.width ?? 0,
      height: track.height ?? 0,
      channels: track.channels ?? 2,
      sampleRate: track.sampleRate ?? track.timescale,
      codecPrivate: track.codecPrivate,
    });
  if (sampleEntry === null) return null;

  return {
    kind: track.kind,
    codec: track.codec,
    timescale: track.timescale,
    language: track.language,
    width: track.width ?? 0,
    height: track.height ?? 0,
    sampleEntry,
    matrix: track.matrix,
    edits: track.edits,
    samples: track.samples,
  };
}

export function remux(bytes: Uint8Array, operation: Operation): ToolResult<RemuxOutcome> {
  const container = detectContainer(bytes);
  if (container === null) return refuseUnknownContainer(bytes);

  const read = container === 'mp4' ? readIsoBmff(bytes) : readMatroska(bytes);
  if (!read.ok) return read;
  const file = read.value;

  const { kept, dropped } = selectTracks(file, operation);
  if (kept.length === 0) return refuseSelection(file, operation);

  const notes: RemuxNote[] = [];

  /* -- What is not coming, named one reason at a time --------------------- */

  for (const track of dropped) {
    // Nothing is said about a picture when the user asked for the sound. It is
    // not a loss they are experiencing, and a warning that a VP9 video track
    // did not come along is noise on a result that was never going to have one.
    if (operation === 'audio' && track.kind !== 'audio') continue;

    const facts = CODECS[track.codec];
    const kind = track.kind === 'other' ? 'A' : `A ${track.kind}`;
    const language = track.language === null ? '' : ` in ${track.language}`;

    if (!facts.carried) {
      notes.push({
        level: track.kind === 'other' ? 'info' : 'warn',
        title: `${kind} track${language} was dropped: ${facts.label}`,
        body: facts.refusal ?? 'This version carries H.264, H.265, AAC and MP3.',
      });
      continue;
    }
    notes.push({
      level: 'warn',
      title: `A second ${track.kind} track${language} was dropped`,
      body: 'One stream of each kind travels. Almost no player offers a track menu for an MP4, so carrying the rest would multiply the size of the file with nothing able to reach them.',
    });
  }

  const metadata = metadataNote(file.metadata);
  if (metadata !== null) notes.push(metadata);

  if (file.problem !== null) {
    notes.push({
      level: 'warn',
      title: 'The file is damaged, and this is what could be read out of it',
      body: `While reading it, ${file.problem}. Everything before that point was repackaged; anything after it is not in the result.`,
    });
  }

  if (kept.some((track) => track.matrix !== null)) {
    notes.push({
      level: 'info',
      title: 'The rotation was carried across',
      body: 'This video is stored one way round and displayed another, which is what a phone held upright records. The transform came with it, so the result is the same way up as the original.',
    });
  }

  /* -- Raw audio, where a container would only be in the way -------------- */

  const only = kept[0];
  if (operation === 'audio' && kept.length === 1 && only?.codec === 'mp3') {
    const total = only.samples.size.reduce((sum, size) => sum + size, 0);
    if (total > outputCeiling(bytes.byteLength)) {
      return fail('limit-exceeded', 'That file describes far more audio than it contains.', {
        detail: `Its index asks for ${String(Math.round(total / 1024 / 1024))} MB out of a ${String(Math.round(bytes.byteLength / 1024 / 1024))} MB file, which no real recording does.`,
      });
    }

    const out = new Uint8Array(total);
    let at = 0;
    for (let index = 0; index < only.samples.count; index += 1) {
      const from = only.samples.offset[index] ?? 0;
      const size = only.samples.size[index] ?? 0;
      out.set(bytes.subarray(from, from + size), at);
      at += size;
    }

    notes.push({
      level: 'info',
      title: 'Written as a bare MP3 stream',
      body: 'MP3 frames carry their own headers, so an audio-only MP3 needs no container at all. The result is the frames as they were, in order, with nothing added.',
    });

    return ok(
      outcome({
        file,
        kept,
        bytes: out,
        mediaType: 'audio/mpeg',
        extension: 'mp3',
        sourceBytes: bytes.byteLength,
        notes,
      }),
    );
  }

  /* -- Everything else is an MP4 ------------------------------------------ */

  const tracks: OutputTrack[] = [];
  // Paired with `tracks`, because a track can be dropped HERE - after the
  // selection - for want of a decoder configuration, and the report has to
  // describe the streams that actually travelled rather than the ones that
  // were chosen. Taking the first N of `kept` instead would name the video
  // track on a file whose video was the one dropped.
  const carried: SourceTrack[] = [];

  for (const track of kept) {
    const built = toOutputTrack(track);
    if (built === null) {
      notes.push({
        level: 'warn',
        title: `The ${track.kind} track was dropped: it carries no decoder configuration`,
        body: 'The file describes the stream but never says how to start decoding it. Writing the track anyway would produce a file that looks complete and plays nothing.',
      });
      continue;
    }
    tracks.push(built);
    carried.push(track);
  }

  if (tracks.length === 0) {
    return fail(
      'parse-error',
      'That file describes its streams without saying how to decode them.',
      {
        detail:
          'Every track was missing the configuration record a decoder needs. A file in this state is normally one an encoder never finished writing.',
      },
    );
  }

  const media = mediaSize(tracks);
  if (media > outputCeiling(bytes.byteLength)) {
    return fail('limit-exceeded', 'That file describes far more media than it contains.', {
      detail: `Its index asks for ${String(Math.round(media / 1024 / 1024))} MB out of a ${String(Math.round(bytes.byteLength / 1024 / 1024))} MB file. A repackage copies, so it cannot honestly produce more than it was given.`,
    });
  }

  const audioOnly = tracks.every((track) => track.kind === 'audio');
  const out = writeMp4({
    source: bytes,
    tracks,
    // The movie timescale is carried from the source so a copied edit list
    // still means what it meant. Matroska has no movie timescale and no edit
    // lists, and 1000 is what its own timestamps are already in.
    timescale: file.container === 'mp4' ? file.timescale : 1000,
    majorBrand: audioOnly ? 'M4A ' : 'isom',
    compatibleBrands: audioOnly
      ? ['M4A ', 'isom', 'iso2', 'mp41']
      : ['isom', 'iso2', 'avc1', 'mp41'],
  });

  if (file.container === 'mp4' && operation === 'container') {
    notes.push({
      level: 'info',
      title: 'This file was already an MP4',
      body: 'It has been rebuilt with its index at the front, which is what lets a player start before the download finishes, and with only the streams listed above.',
    });
  }

  return ok(
    outcome({
      file,
      kept: carried,
      bytes: out,
      mediaType: audioOnly ? 'audio/mp4' : 'video/mp4',
      extension: audioOnly ? 'm4a' : 'mp4',
      sourceBytes: bytes.byteLength,
      notes,
    }),
  );
}

/* ========================================================================== *
 * The report
 * ========================================================================== */

interface OutcomeParts {
  readonly file: SourceFile;
  readonly kept: readonly SourceTrack[];
  readonly bytes: Bytes;
  readonly mediaType: string;
  readonly extension: string;
  readonly sourceBytes: number;
  readonly notes: readonly RemuxNote[];
}

function outcome(parts: OutcomeParts): RemuxOutcome {
  const { file, kept } = parts;
  const sourceVideo = file.tracks.find((track) => track.kind === 'video');
  const keptVideo = kept.find((track) => track.kind === 'video');

  const sourceSeconds =
    file.durationSeconds ?? Math.max(0, ...file.tracks.map((track) => trackSeconds(track) ?? 0));
  const keptSeconds = Math.max(0, ...kept.map((track) => trackSeconds(track) ?? 0));

  const from: StreamFacts = {
    format: describeStreams(
      file.container,
      file.tracks.filter((track) => track.kind !== 'other'),
    ),
    width: sourceVideo?.width ?? null,
    height: sourceVideo?.height ?? null,
    duration: formatDuration(sourceSeconds),
    frames: sourceVideo?.samples.count ?? null,
    bytes: parts.sourceBytes,
    metadata: file.metadata,
  };

  const to: StreamFacts = {
    format: describeStreams(parts.extension, kept),
    width: keptVideo?.width ?? null,
    height: keptVideo?.height ?? null,
    duration: formatDuration(keptSeconds),
    frames: keptVideo?.samples.count ?? null,
    bytes: parts.bytes.byteLength,
    /*
     * Not "what we happened to drop" but a promise about every file this tool
     * produces. The writer emits `moov` and `mdat` and nothing else - no
     * `udta`, no `meta`, no creation timestamps, which are written as zero. A
     * test asserts it on the bytes rather than trusting this sentence.
     */
    metadata: [],
  };

  return {
    bytes: parts.bytes,
    mediaType: parts.mediaType,
    extension: parts.extension,
    from,
    to,
    notes: parts.notes,
  };
}
