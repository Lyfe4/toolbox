import { describe, expect, it } from 'vitest';

import {
  aacConfig,
  avcConfig,
  makeMatroska,
  makeMp4,
  ROTATION_MATRIX,
  sampleBytes,
  type FixtureTrack,
} from './fixtures';
import { readIsoBmff } from './isobmff';
import { readMatroska } from './matroska';
import { remux } from './remux';

import type { SourceFile } from './containers';

/**
 * WHAT A REPACKAGE HAS TO BE TRUE OF.
 *
 * One property dominates every test here and it is worth stating once: THE
 * COMPRESSED FRAMES COME OUT BYTE FOR BYTE. Not "the file plays", which no
 * harness in this repository can judge, and not "the boxes are well formed",
 * which is a weaker claim than it sounds - a file whose index is immaculate
 * and whose offsets are four bytes out is well formed and is noise.
 *
 * So the shape of almost every assertion below is: build a container by hand
 * with distinguishable bytes in every sample, repackage it, read the RESULT's
 * own index, pull the samples back out through it, and compare. That closes
 * the loop through both the writer's offsets and the reader's arithmetic at
 * once, and it is a real assertion about a real answer rather than a structural
 * one.
 */

/** Pulls every track's samples back out of a finished MP4, through its index. */
function samplesOf(bytes: Uint8Array): {
  readonly file: SourceFile;
  readonly tracks: Uint8Array[][];
} {
  const read = readIsoBmff(bytes);
  if (!read.ok) throw new Error(`the output could not be read back: ${read.error.message}`);

  const tracks = read.value.tracks.map((track) => {
    const out: Uint8Array[] = [];
    for (let index = 0; index < track.samples.count; index += 1) {
      const at = track.samples.offset[index] ?? 0;
      out.push(bytes.subarray(at, at + (track.samples.size[index] ?? 0)));
    }
    return out;
  });

  return { file: read.value, tracks };
}

function expectSame(got: readonly Uint8Array[], wanted: readonly Uint8Array[]): void {
  expect(got.map((sample) => [...sample])).toEqual(wanted.map((sample) => [...sample]));
}

const videoSamples = [
  sampleBytes(1, 900),
  sampleBytes(2, 140),
  sampleBytes(3, 155),
  sampleBytes(4, 130),
  sampleBytes(5, 700),
  sampleBytes(6, 120),
];
const audioSamples = [
  sampleBytes(11, 380),
  sampleBytes(12, 384),
  sampleBytes(13, 379),
  sampleBytes(14, 381),
];

const videoTrack: FixtureTrack = {
  kind: 'video',
  fourcc: 'avc1',
  timescale: 30_000,
  delta: 1000,
  samples: videoSamples,
  width: 1920,
  height: 1080,
  // A reordered stream: the second and third frames are shown in the other
  // order from the one they decode in, which is what a B-frame is.
  compositionOffsets: [0, 2000, 0, 1000, 0, 1000],
  syncSamples: [1, 5],
  perChunk: 4,
  language: 'eng',
};

const audioTrack: FixtureTrack = {
  kind: 'audio',
  fourcc: 'mp4a',
  timescale: 44_100,
  delta: 1024,
  samples: audioSamples,
  channels: 2,
  // The QuickTime layout a camera writes, whose fixed part is sixteen bytes
  // longer - the shape that hides `esds` from a reader assuming version 0.
  audioEntryVersion: 1,
  perChunk: 3,
  language: 'fra',
};

/* ========================================================================== *
 * MP4 in, MP4 out
 * ========================================================================== */

describe('repackaging an ISO base media file', () => {
  const source = makeMp4({ tracks: [videoTrack, audioTrack], location: '+51.5074-0.1278/' });

  it('carries every compressed frame across byte for byte', () => {
    const done = remux(source, 'container');
    if (!done.ok) throw new Error(done.error.message);

    const { tracks } = samplesOf(done.value.bytes);
    expect(tracks).toHaveLength(2);
    expectSame(tracks[0] ?? [], videoSamples);
    expectSame(tracks[1] ?? [], audioSamples);
  });

  it('keeps the decode and presentation times apart', () => {
    const done = remux(source, 'container');
    if (!done.ok) throw new Error(done.error.message);

    const video = samplesOf(done.value.bytes).file.tracks[0];
    expect(video?.samples.dts).toEqual([0, 1000, 2000, 3000, 4000, 5000]);
    // The reordering survives: a frame shown two thousand ticks after it
    // decodes is what makes a B-frame stream play in the right order.
    expect(video?.samples.cts).toEqual([0, 3000, 2000, 4000, 4000, 6000]);
  });

  it('keeps which frames a player may seek to', () => {
    const done = remux(source, 'container');
    if (!done.ok) throw new Error(done.error.message);
    // An absent `stss` would mean EVERY sample is seekable, which is the
    // plausible wrong answer: the file still plays and scrubbing lands on a
    // frame no decoder can start from.
    expect(samplesOf(done.value.bytes).file.tracks[0]?.samples.sync).toEqual([1, 0, 0, 0, 1, 0]);
  });

  it('carries the rotation, so a portrait video is not sideways', () => {
    const rotated = makeMp4({ tracks: [{ ...videoTrack, matrix: ROTATION_MATRIX }] });
    const done = remux(rotated, 'container');
    if (!done.ok) throw new Error(done.error.message);

    const matrix = samplesOf(done.value.bytes).file.tracks[0]?.matrix;
    expect([...(matrix ?? [])]).toEqual([...ROTATION_MATRIX]);
  });

  it('carries the edit list, which is how a track says it starts late', () => {
    const delayed = makeMp4({
      tracks: [{ ...videoTrack, edits: [{ duration: 100, mediaTime: -1 }] }],
    });
    const done = remux(delayed, 'container');
    if (!done.ok) throw new Error(done.error.message);

    expect(samplesOf(done.value.bytes).file.tracks[0]?.edits).toEqual([
      { segmentDuration: 100, mediaTime: -1, mediaRateInteger: 1, mediaRateFraction: 0 },
    ]);
  });

  it('puts the index in front of the media, which the source did not', () => {
    const done = remux(source, 'container');
    if (!done.ok) throw new Error(done.error.message);

    const text = new TextDecoder('latin1').decode(done.value.bytes);
    expect(text.indexOf('moov')).toBeGreaterThan(0);
    expect(text.indexOf('moov')).toBeLessThan(text.indexOf('mdat'));
    // And the fixture really is the other way round, or this proves nothing.
    const original = new TextDecoder('latin1').decode(source);
    expect(original.indexOf('mdat')).toBeLessThan(original.indexOf('moov'));
  });

  it('finds the audio configuration behind a QuickTime version 1 entry', () => {
    // Version 1 puts sixteen extra bytes before the sub-boxes. Reading it as
    // version 0 looks for `esds` in the middle of them, finds nothing, and
    // reports the track as an unrecognised codec.
    const read = readIsoBmff(source);
    if (!read.ok) throw new Error(read.error.message);
    expect(read.value.tracks[1]?.codec).toBe('aac');
  });

  it('reports the location it removed, and does not carry it', () => {
    const done = remux(source, 'container');
    if (!done.ok) throw new Error(done.error.message);

    const report = done.value;
    expect(report.from.metadata).toContain('GPS location');
    expect(report.to.metadata).toEqual([]);
    expect(report.notes.some((note) => note.title.includes('GPS location'))).toBe(true);

    // Asserted on the bytes rather than on the promise: someone about to share
    // a video is entitled to more than a sentence in a README.
    const text = new TextDecoder('latin1').decode(done.value.bytes);
    expect(text).not.toContain('51.5074');
    expect(text).not.toContain('udta');
  });

  it('says what it is, in the language a person uses for it', () => {
    const done = remux(source, 'container');
    if (!done.ok) throw new Error(done.error.message);
    expect(done.value.from.format).toBe('MP4 · H.264 + AAC');
    expect(done.value.to.format).toBe('MP4 · H.264 + AAC');
    expect(done.value.from.duration).toBe('0:00');
    expect(done.value.extension).toBe('mp4');
  });
});

/* ========================================================================== *
 * Matroska in, MP4 out
 * ========================================================================== */

describe('repackaging a Matroska file', () => {
  const laced = [sampleBytes(21, 300), sampleBytes(22, 310), sampleBytes(23, 305)];

  const source = makeMatroska({
    tracks: [
      {
        number: 1,
        kind: 'video',
        codecId: 'V_MPEG4/ISO/AVC',
        codecPrivate: avcConfig(),
        width: 1280,
        height: 720,
        defaultDuration: 33_333_333,
      },
      {
        number: 2,
        kind: 'audio',
        codecId: 'A_AAC',
        codecPrivate: aacConfig(),
        channels: 2,
        sampleRate: 44_100,
      },
    ],
    blocks: [
      { track: 1, time: 0, frames: [videoSamples[0] ?? new Uint8Array(0)] },
      { track: 2, time: 0, frames: laced, lacing: 'ebml' },
      {
        track: 1,
        time: 33,
        frames: [videoSamples[1] ?? new Uint8Array(0)],
        keyframe: false,
        inBlockGroup: true,
      },
      {
        track: 1,
        time: 66,
        frames: [videoSamples[2] ?? new Uint8Array(0)],
        keyframe: false,
        inBlockGroup: true,
      },
      { track: 2, time: 70, frames: [audioSamples[0] ?? new Uint8Array(0)] },
    ],
    durationTicks: 100,
    dateUtc: true,
    tags: true,
  });

  it('takes a laced block apart into one sample per frame', () => {
    const read = readMatroska(source);
    if (!read.ok) throw new Error(read.error.message);
    // Three laced frames plus one ordinary block. A reader that does not
    // understand lacing produces two samples here, both of which decode - the
    // audio is simply three frames long where it should be one.
    expect(read.value.tracks[1]?.samples.count).toBe(4);
  });

  it('gives the frames inside a lace consecutive times, not the same one', () => {
    const read = readMatroska(source);
    if (!read.ok) throw new Error(read.error.message);
    const dts = read.value.tracks[1]?.samples.dts ?? [];
    // 1024 samples at 44.1 kHz is 23 ms, and the timescale here is 1000.
    expect(dts.slice(0, 3)).toEqual([0, 23, 46]);
  });

  it('carries every frame across byte for byte', () => {
    const done = remux(source, 'container');
    if (!done.ok) throw new Error(done.error.message);

    const { tracks } = samplesOf(done.value.bytes);
    expectSame(tracks[0] ?? [], videoSamples.slice(0, 3));
    expectSame(tracks[1] ?? [], [...laced, audioSamples[0] ?? new Uint8Array(0)]);
  });

  it('builds a sample entry around the file’s own configuration record', () => {
    const done = remux(source, 'container');
    if (!done.ok) throw new Error(done.error.message);

    const entry = samplesOf(done.value.bytes).file.tracks[0]?.sampleEntry ?? new Uint8Array(0);
    const text = new TextDecoder('latin1').decode(entry);
    expect(text).toContain('avc1');
    expect(text).toContain('avcC');
    // Matroska stores H.264 exactly as an MP4 does, so the configuration is
    // carried rather than rebuilt: nothing here invents a parameter set.
    expect([...entry.subarray(entry.length - avcConfig().length)]).toEqual([...avcConfig()]);
  });

  it('reads keyframes from the block group, where there is no flag to read', () => {
    const done = remux(source, 'container');
    if (!done.ok) throw new Error(done.error.message);
    // A SimpleBlock states it in its flags; a Block inside a BlockGroup is a
    // keyframe exactly when nothing references another frame.
    expect(samplesOf(done.value.bytes).file.tracks[0]?.samples.sync).toEqual([1, 0, 0]);
  });

  it('describes the streams that travelled, not the ones that were chosen', () => {
    // The video track is dropped here for want of a configuration record, so
    // the audio is the only thing that goes. Reporting "the first one kept"
    // would name H.264 on a file whose H.264 was the part that did not make it.
    const halfBroken = makeMatroska({
      tracks: [
        { number: 1, kind: 'video', codecId: 'V_MPEG4/ISO/AVC', width: 640, height: 480 },
        {
          number: 2,
          kind: 'audio',
          codecId: 'A_AAC',
          codecPrivate: aacConfig(),
          channels: 2,
          sampleRate: 44_100,
        },
      ],
      blocks: [
        { track: 1, time: 0, frames: [sampleBytes(61, 120)] },
        { track: 2, time: 0, frames: [sampleBytes(62, 90)] },
      ],
    });

    const done = remux(halfBroken, 'container');
    if (!done.ok) throw new Error(done.error.message);
    // And what is left is audio, so it is written and named as audio - asking
    // to repackage as MP4 and getting a `.mp4` with no picture in it would be
    // the more surprising of the two answers.
    expect(done.value.to.format).toBe('M4A · AAC');
    expect(done.value.extension).toBe('m4a');
    expect(done.value.to.width).toBeNull();
    expect(done.value.notes.some((note) => note.title.includes('no decoder configuration'))).toBe(
      true,
    );
  });

  it('reports the recording date and the tags it left behind', () => {
    const done = remux(source, 'container');
    if (!done.ok) throw new Error(done.error.message);
    expect(done.value.from.metadata).toEqual(['Recording date', 'Titles and tags']);
    expect(done.value.from.format).toBe('Matroska · H.264 + AAC');
    expect(done.value.to.format).toBe('MP4 · H.264 + AAC');
  });
});

/* ========================================================================== *
 * Audio
 * ========================================================================== */

describe('extracting the audio track', () => {
  it('writes AAC into an M4A holding nothing else', () => {
    const source = makeMp4({ tracks: [videoTrack, audioTrack] });
    const done = remux(source, 'audio');
    if (!done.ok) throw new Error(done.error.message);

    expect(done.value.mediaType).toBe('audio/mp4');
    expect(done.value.extension).toBe('m4a');

    const { file, tracks } = samplesOf(done.value.bytes);
    expect(file.tracks).toHaveLength(1);
    expect(file.tracks[0]?.kind).toBe('audio');
    expectSame(tracks[0] ?? [], audioSamples);
    // `M4A ` rather than `isom`, which is what tells a music player it is
    // looking at a song rather than a film with no picture - and the report
    // says the same thing in the language a person uses for it.
    expect(file.flavour).toBe('M4A');
    expect(done.value.to.format).toBe('M4A · AAC');
  });

  it('writes MP3 as a bare stream, because its frames need no container', () => {
    const frames = [sampleBytes(31, 417), sampleBytes(32, 418), sampleBytes(33, 417)];
    const source = makeMatroska({
      tracks: [{ number: 1, kind: 'audio', codecId: 'A_MPEG/L3', channels: 2, sampleRate: 44_100 }],
      blocks: frames.map((frame, index) => ({ track: 1, time: index * 26, frames: [frame] })),
    });

    const done = remux(source, 'audio');
    if (!done.ok) throw new Error(done.error.message);

    expect(done.value.extension).toBe('mp3');
    expect(done.value.mediaType).toBe('audio/mpeg');
    expect([...done.value.bytes]).toEqual([...frames.flatMap((frame) => [...frame])]);
  });

  it('says nothing about a picture when the picture was never wanted', () => {
    // A VP9 video track cannot be repackaged, and on an audio extraction that
    // is not a loss anybody is experiencing. Warning about it would be noise
    // on a result that was never going to have a picture in it.
    const source = makeMatroska({
      tracks: [
        { number: 1, kind: 'video', codecId: 'V_VP9', width: 640, height: 480 },
        {
          number: 2,
          kind: 'audio',
          codecId: 'A_AAC',
          codecPrivate: aacConfig(),
          channels: 2,
          sampleRate: 44_100,
        },
      ],
      blocks: [
        { track: 1, time: 0, frames: [sampleBytes(71, 200)] },
        { track: 2, time: 0, frames: [sampleBytes(72, 90)] },
      ],
    });

    const done = remux(source, 'audio');
    if (!done.ok) throw new Error(done.error.message);
    expect(done.value.notes.some((note) => note.title.includes('VP9'))).toBe(false);

    // And the same file, repackaged, names VP9 as the reason it will not be -
    // which is what makes the silence above a decision rather than a dropped
    // message. It is a refusal rather than a note because handing back the
    // soundtrack of a video the user asked to repackage is the wrong answer to
    // a question they did not ask: see `refuseAudioOnlyRepackage`.
    const asVideo = remux(source, 'container');
    expect(asVideo.ok).toBe(false);
    if (asVideo.ok) return;
    expect(asVideo.error.message).toContain('VP9');
  });

  it('refuses a file with no audio in it, rather than producing an empty one', () => {
    const source = makeMp4({ tracks: [videoTrack] });
    const done = remux(source, 'audio');
    expect(done.ok).toBe(false);
    if (done.ok) return;
    expect(done.error.message).toContain('no audio');
  });
});

/* ========================================================================== *
 * What it will not do, and says so
 * ========================================================================== */

describe('the refusals', () => {
  it('will not put a WebM’s codecs in an MP4, and names both', () => {
    const source = makeMatroska({
      docType: 'webm',
      tracks: [
        { number: 1, kind: 'video', codecId: 'V_VP9', width: 640, height: 480 },
        { number: 2, kind: 'audio', codecId: 'A_OPUS', channels: 2, sampleRate: 48_000 },
      ],
      blocks: [
        { track: 1, time: 0, frames: [sampleBytes(41, 200)] },
        { track: 2, time: 0, frames: [sampleBytes(42, 100)] },
      ],
    });

    const done = remux(source, 'container');
    expect(done.ok).toBe(false);
    if (done.ok) return;
    expect(done.error.code).toBe('unsupported-type');
    expect(done.error.detail).toContain('VP9');
    expect(done.error.detail).toContain('Opus');
    // The sentence that makes the refusal useful rather than merely correct.
    expect(done.error.detail).toContain('already plays');
  });

  it('drops a subtitle track and says which one', () => {
    const source = makeMp4({
      tracks: [
        videoTrack,
        { ...audioTrack },
        {
          kind: 'other',
          fourcc: 'tx3g',
          timescale: 1000,
          delta: 100,
          samples: [sampleBytes(51, 20)],
        },
      ],
    });

    const done = remux(source, 'container');
    if (!done.ok) throw new Error(done.error.message);
    expect(done.value.notes.some((note) => note.title.includes('Subtitles'))).toBe(true);
    expect(samplesOf(done.value.bytes).file.tracks).toHaveLength(2);
  });

  it('keeps one audio track and names the one it left', () => {
    const source = makeMp4({
      tracks: [videoTrack, audioTrack, { ...audioTrack, language: 'deu' }],
    });

    const done = remux(source, 'container');
    if (!done.ok) throw new Error(done.error.message);
    expect(done.value.notes.some((note) => note.title.includes('in deu'))).toBe(true);
  });

  it('says a fragmented MP4 is a fragmented MP4', () => {
    // `moof` and no `moov`, which is what a streaming segment looks like.
    const source = makeMp4({ tracks: [videoTrack] });
    const text = new TextDecoder('latin1').decode(source);
    const at = text.indexOf('moov');
    const broken = new Uint8Array(source);
    broken.set([0x6d, 0x6f, 0x6f, 0x66], at);

    const done = remux(broken, 'container');
    expect(done.ok).toBe(false);
    if (done.ok) return;
    expect(done.error.message).toContain('fragmented');
  });

  it('refuses something that is not a video at all', () => {
    const done = remux(new Uint8Array(64).fill(0x41), 'container');
    expect(done.ok).toBe(false);
    if (done.ok) return;
    expect(done.error.code).toBe('unsupported-type');
    expect(done.error.detail).toContain('never from the name');
  });
});
