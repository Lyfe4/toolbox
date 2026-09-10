import { describe, expect, it } from 'vitest';

import { readAvi } from './avi';
import {
  annexB,
  avcPps,
  avcSlice,
  avcSps,
  makeAvi,
  MP3_FRAME_BYTES,
  mpegAudioFrameBytes,
  sampleBytes,
} from './fixtures';
import { readIsoBmff } from './isobmff';
import { remux } from './remux';

/**
 * WHAT READING AVI IS ACTUALLY FOR, ASSERTED.
 *
 * Most of this file is about refusals, and that is the honest shape of the
 * feature rather than a gap in the tests. The video in a real AVI is MPEG-4
 * Part 2, or Motion JPEG, or MPEG-2, and none of those can travel into an MP4
 * that plays anywhere the AVI did not already play - so the first two tests
 * below are the two answers this reader mostly gives:
 *
 *   - "Your video is Xvid, and a container change cannot convert a codec."
 *   - And the soundtrack, extracted exactly, because it is MP3.
 *
 * The rest are the sharp edges of the format itself. Three of them produce
 * output that plays and is wrong, which is the kind this repository writes
 * down: an index whose offsets mean two different things, a zero-length chunk
 * that is a frame, and audio frames that straddle the chunks holding them.
 */

/** Reads a finished MP4 back through this tool's own ISO-BMFF reader. */
function samplesOf(bytes: Uint8Array): {
  readonly kinds: string[];
  readonly tracks: Uint8Array[][];
  readonly sync: readonly (readonly number[])[];
  readonly sizes: readonly (readonly [number | null, number | null])[];
  readonly dts: readonly (readonly number[])[];
} {
  const read = readIsoBmff(bytes);
  if (!read.ok) throw new Error(`the output could not be read back: ${read.error.message}`);

  return {
    kinds: read.value.tracks.map((track) => track.kind),
    tracks: read.value.tracks.map((track) => {
      const out: Uint8Array[] = [];
      for (let index = 0; index < track.samples.count; index += 1) {
        const at = track.samples.offset[index] ?? 0;
        out.push(bytes.subarray(at, at + (track.samples.size[index] ?? 0)));
      }
      return out;
    }),
    sync: read.value.tracks.map((track) => track.samples.sync),
    sizes: read.value.tracks.map((track) => [track.width, track.height] as const),
    dts: read.value.tracks.map((track) => track.samples.dts),
  };
}

/** Pulls the length-prefixed NAL units out of one finished MP4 sample. */
function nalsIn(sample: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let at = 0;
  while (at + 4 <= sample.byteLength) {
    const length =
      (sample[at] ?? 0) * 0x1000000 +
      ((sample[at + 1] ?? 0) << 16) +
      ((sample[at + 2] ?? 0) << 8) +
      (sample[at + 3] ?? 0);
    if (length <= 0 || at + 4 + length > sample.byteLength) break;
    out.push(sample.subarray(at + 4, at + 4 + length));
    at += 4 + length;
  }
  return out;
}

/* ========================================================================== *
 * The film that will not play, which is why anybody opens this tool
 * ========================================================================== */

describe('an old AVI film: Xvid video with MP3 sound', () => {
  const mp3Frames = [
    mpegAudioFrameBytes(1),
    mpegAudioFrameBytes(2),
    mpegAudioFrameBytes(3),
    mpegAudioFrameBytes(4),
  ];
  const stream = new Uint8Array(mp3Frames.flatMap((frame) => [...frame]));

  /*
   * The audio chunks deliberately do NOT line up with the frames. An AVI's
   * interleaver chose these sizes to keep the video and the audio near each
   * other on a spinning disc, and it knew nothing about where an MP3 frame
   * ends - so two of the four frames below straddle a chunk boundary.
   */
  const audioChunks = [stream.subarray(0, 600), stream.subarray(600, 1000), stream.subarray(1000)];

  const source = makeAvi({
    streams: [
      {
        kind: 'vids',
        fourcc: 'XVID',
        scale: 1,
        rate: 25,
        width: 720,
        height: 400,
        chunks: [sampleBytes(21, 4000), sampleBytes(22, 1200), sampleBytes(23, 1201)],
        keyframes: [0],
      },
      {
        kind: 'auds',
        formatTag: 0x0055,
        scale: 1,
        rate: 44_100,
        channels: 2,
        sampleRate: 44_100,
        chunks: audioChunks,
      },
    ],
    info: true,
  });

  it('refuses to repackage it, and names the codec that is the reason', () => {
    /*
     * THE DECISION THIS TEST PINS. The Xvid video cannot travel, the MP3 audio
     * can - so the selection keeps one track and the writer would happily
     * produce a perfectly good `.m4a`. That is a film going in and a
     * soundtrack coming out under the label "Repackaged", which is the
     * plausible-wrong-answer shape applied to a whole feature.
     */
    const done = remux(source, 'container');
    expect(done.ok).toBe(false);
    if (done.ok) return;
    // Named the way somebody holding the file names it, which is the point of
    // the label: nobody has an "MPEG-4 Part 2" film, they have a DivX one.
    expect(done.error.message).toContain('MPEG-4 Part 2 (DivX or Xvid)');
    // And it says what to do instead, which is the half that makes it useful.
    expect(done.error.detail).toContain('Extract the audio track');
  });

  it('lifts the soundtrack out frame for frame, across the chunk boundaries', () => {
    const done = remux(source, 'audio');
    if (!done.ok) throw new Error(done.error.message);
    expect(done.value.extension).toBe('mp3');
    // Every byte of every frame, in order, including the two that were split
    // between chunks. A reader that took a chunk as a frame would produce
    // three samples of the wrong lengths and audio that clicks.
    expect([...done.value.bytes]).toEqual([...stream]);
  });

  it('finds the frames rather than the chunks, and times them by the codec', () => {
    const read = readAvi(source);
    if (!read.ok) throw new Error(read.error.message);
    const audio = read.value.tracks.find((track) => track.kind === 'audio');

    expect(audio?.samples.count).toBe(4);
    expect(audio?.samples.size).toEqual([
      MP3_FRAME_BYTES,
      MP3_FRAME_BYTES,
      MP3_FRAME_BYTES,
      MP3_FRAME_BYTES,
    ]);
    // An MPEG-1 Layer III frame is 1152 samples, always. The AVI header's
    // nominal rate is not consulted for this and does not need to be.
    expect(audio?.samples.dts).toEqual([0, 1152, 2304, 3456]);
    expect(audio?.timescale).toBe(44_100);
  });

  it('still names the video, so the refusal can say what the file holds', () => {
    const read = readAvi(source);
    if (!read.ok) throw new Error(read.error.message);
    const video = read.value.tracks.find((track) => track.kind === 'video');
    expect(video?.codec).toBe('mpeg4part2');
    expect([video?.width, video?.height]).toEqual([720, 400]);
    // With no samples read, because reading half a gigabyte of frames to
    // print one sentence about Xvid would be the wrong trade.
    expect(video?.samples.count).toBe(0);
  });

  it('says the titles and tags were left behind', () => {
    const done = remux(source, 'audio');
    if (!done.ok) throw new Error(done.error.message);
    expect(done.value.from.metadata).toEqual(['Titles and tags']);
  });
});

/* ========================================================================== *
 * The AVI that does repackage
 * ========================================================================== */

describe('an AVI carrying H.264, which some capture hardware writes', () => {
  const sps = avcSps();
  const pps = avcPps();
  const idr = avcSlice(5, 31, 800);
  const later = [avcSlice(1, 32, 210), avcSlice(1, 33, 190)];

  const source = makeAvi({
    streams: [
      {
        kind: 'vids',
        fourcc: 'H264',
        scale: 1,
        rate: 30,
        width: 640,
        height: 480,
        chunks: [
          annexB(sps, pps, idr),
          annexB(later[0] ?? idr),
          // A ZERO-LENGTH CHUNK, which is how an AVI says "this frame is the
          // same as the last one". It is a frame: time passes.
          new Uint8Array(0),
          annexB(later[1] ?? idr),
        ],
        keyframes: [0],
      },
    ],
    grouped: true,
  });

  it('carries every coded picture across, unit for unit', () => {
    const done = remux(source, 'container');
    if (!done.ok) throw new Error(done.error.message);
    const read = samplesOf(done.value.bytes);
    expect((read.tracks[0] ?? []).flatMap(nalsIn).map((nal) => [...nal])).toEqual(
      [idr, later[0] ?? idr, later[1] ?? idr].map((nal) => [...nal]),
    );
  });

  it('lets a dropped frame consume its own frame of time', () => {
    /*
     * THE FAILURE THIS EXISTS FOR. Three samples come out of four chunks, and
     * the third sample belongs at frame 3 rather than at frame 2. A reader
     * that skips the empty chunk entirely produces a video one frame shorter
     * than its soundtrack for every dropped frame in the file - which on an
     * old capture is hundreds, and which presents as sound drifting steadily
     * ahead of picture rather than as anything being missing.
     */
    const done = remux(source, 'container');
    if (!done.ok) throw new Error(done.error.message);
    expect(samplesOf(done.value.bytes).dts[0]).toEqual([0, 1, 3]);
  });

  it('takes the keyframe flags from the index and the offsets from the movie list', () => {
    /*
     * The fixture's `idx1` offsets are deliberate nonsense - 0xDEADBEEF - and
     * its keyframe flags are correct. Whether an AVI's index offsets are
     * measured from the file or from the `movi` list has never been settled,
     * and a reader that guesses wrong indexes chunk headers instead of frames:
     * video that decodes into noise, from a file that parsed perfectly.
     *
     * So the offsets come from walking `movi`, which cannot be ambiguous, and
     * the index is consulted only for the one thing it is the only source of.
     * That the samples above came out right IS this assertion; the flag below
     * is the other half.
     */
    const done = remux(source, 'container');
    if (!done.ok) throw new Error(done.error.message);
    expect(samplesOf(done.value.bytes).sync[0]).toEqual([1, 0, 0]);
  });

  it('descends into a `rec ` group, which changes nothing about the data', () => {
    // The fixture above is grouped. A reader that does not descend finds no
    // chunks belonging to any stream and reports an empty movie list.
    const read = readAvi(source);
    if (!read.ok) throw new Error(read.error.message);
    expect(read.value.tracks[0]?.samples.count).toBe(3);
  });

  it('says the framing was rebuilt, because these frames were Annex B', () => {
    const done = remux(source, 'container');
    if (!done.ok) throw new Error(done.error.message);
    expect(done.value.notes.some((note) => note.title.includes('framing was rebuilt'))).toBe(true);
  });

  it('believes the parameter set over the bitmap header about the size', () => {
    /*
     * The one reader that prefers the bitstream, because AVI has no display
     * size to prefer: a `BITMAPINFOHEADER` states the coded size, the same
     * thing the parameter set states, and it is written by the muxer rather
     * than by the encoder. So the header here lies - 320 by 240 - and the
     * parameter set says 640 by 480, which is what has to come out.
     */
    const lying = makeAvi({
      streams: [
        {
          kind: 'vids',
          fourcc: 'H264',
          scale: 1,
          rate: 30,
          width: 320,
          height: 240,
          chunks: [annexB(sps, pps, idr)],
          keyframes: [0],
        },
      ],
    });

    const done = remux(lying, 'container');
    if (!done.ok) throw new Error(done.error.message);
    expect(samplesOf(done.value.bytes).sizes[0]).toEqual([640, 480]);
  });

  it('works with no index at all, which is what a cut-short file has', () => {
    const unindexed = makeAvi({
      streams: [
        {
          kind: 'vids',
          fourcc: 'H264',
          scale: 1,
          rate: 30,
          chunks: [annexB(sps, pps, idr), annexB(later[0] ?? idr)],
        },
      ],
      index: false,
    });

    const done = remux(unindexed, 'container');
    if (!done.ok) throw new Error(done.error.message);
    const read = samplesOf(done.value.bytes);
    // And the keyframe is still found, because it comes out of the bitstream:
    // an IDR is written by the encoder and a flag is written by the muxer, and
    // where there is no muxer left to ask, the encoder still knows.
    expect(read.sync[0]).toEqual([1, 0]);
  });
});

/* ========================================================================== *
 * The rest of what turns up in one
 * ========================================================================== */

describe('the other things an AVI holds', () => {
  it('reads an odd-length chunk, whose pad byte is not in its size', () => {
    /*
     * RIFF pads every chunk to an even length and does not count the pad. A
     * walk that advances by the stated size alone lands one byte early on the
     * next header, reads a four-character code straddling two chunks, and
     * finds garbage for the rest of the file - so this is a whole-file failure
     * triggered by one odd number.
     */
    const frames = [mpegAudioFrameBytes(41), mpegAudioFrameBytes(42)];
    const stream = new Uint8Array(frames.flatMap((frame) => [...frame]));
    const source = makeAvi({
      streams: [
        {
          kind: 'auds',
          formatTag: 0x0055,
          scale: 1,
          rate: 44_100,
          // 417 and 417: both odd, so both are padded.
          chunks: [stream.subarray(0, 417), stream.subarray(417)],
        },
      ],
    });

    const done = remux(source, 'audio');
    if (!done.ok) throw new Error(done.error.message);
    expect([...done.value.bytes]).toEqual([...stream]);
  });

  it('tells Layer II from Layer III whatever the format tag says', () => {
    // A file tagged as MP3 whose frames are Layer II exists, and only one of
    // the two can travel. The frame header wins, because the frame is what a
    // decoder will be handed.
    const source = makeAvi({
      streams: [
        {
          kind: 'auds',
          formatTag: 0x0055, // says MP3
          scale: 1,
          rate: 44_100,
          chunks: [mpegAudioFrameBytes(51, true), mpegAudioFrameBytes(52, true)],
        },
      ],
    });

    const read = readAvi(source);
    if (!read.ok) throw new Error(read.error.message);
    expect(read.value.tracks[0]?.codec).toBe('mp2');

    const done = remux(source, 'audio');
    expect(done.ok).toBe(false);
    if (done.ok) return;
    expect(done.error.detail).toContain('Layer II');
  });

  it('names Motion JPEG and uncompressed sound, which is what a camera AVI is', () => {
    const source = makeAvi({
      streams: [
        {
          kind: 'vids',
          fourcc: 'MJPG',
          scale: 1,
          rate: 15,
          chunks: [sampleBytes(61, 900)],
        },
        {
          kind: 'auds',
          formatTag: 0x0001, // PCM
          scale: 1,
          rate: 8000,
          chunks: [sampleBytes(62, 400)],
        },
      ],
    });

    const done = remux(source, 'container');
    expect(done.ok).toBe(false);
    if (done.ok) return;
    expect(done.error.detail).toContain('Motion JPEG');
    expect(done.error.detail).toContain('uncompressed audio');
  });

  it('names a subtitle stream rather than calling it unrecognised', () => {
    const source = makeAvi({
      streams: [
        {
          kind: 'vids',
          fourcc: 'H264',
          scale: 1,
          rate: 25,
          chunks: [annexB(avcSps(), avcPps(), avcSlice(5, 71, 500))],
          keyframes: [0],
        },
        { kind: 'txts', scale: 1, rate: 1000, chunks: [sampleBytes(72, 30)] },
      ],
    });

    const done = remux(source, 'container');
    if (!done.ok) throw new Error(done.error.message);
    expect(done.value.notes.some((note) => note.title.includes('Subtitles'))).toBe(true);
    expect(samplesOf(done.value.bytes).kinds).toEqual(['video']);
  });

  it('refuses something that is RIFF and is not an AVI', () => {
    // A WAV file, which is RIFF with a different type. The container check
    // reads the type rather than stopping at the signature, so this reaches
    // the "not a video" refusal instead of the AVI reader.
    const wav = Uint8Array.from([
      0x52, 0x49, 0x46, 0x46, 0x20, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74,
      0x20, 0x10, 0x00, 0x00, 0x00,
    ]);
    const done = remux(wav, 'container');
    expect(done.ok).toBe(false);
    if (done.ok) return;
    expect(done.error.code).toBe('unsupported-type');
  });
});
