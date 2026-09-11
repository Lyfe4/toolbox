import { describe, expect, it } from 'vitest';

import {
  adtsFrame,
  annexB,
  avcPps,
  avcSlice,
  avcSps,
  avcSpsHigh,
  bytesOf as outputBytes,
  hevcPps,
  hevcSlice,
  hevcSps,
  hevcVps,
  makeTransportStream,
  mpegAudioFrameBytes,
  sampleBytes,
  sourceOf,
  type TsAccessUnit,
} from './fixtures';
import { readIsoBmff } from './isobmff';
import { readMpegTs } from './mpegts';
import { remux } from './remux';

/**
 * WHAT A TRANSPORT STREAM HAS TO SURVIVE, AND WHY IT IS ASSERTED DIFFERENTLY
 * FROM EVERYTHING ELSE HERE.
 *
 * Every other test in this directory turns on one property: the compressed
 * frames come out byte for byte. That property is FALSE for this format, and
 * saying so is the first thing these tests have to get right. A transport
 * stream stores H.264 in Annex B - each NAL unit introduced by a start code,
 * with the parameter sets repeated through the stream - and an MP4 wants each
 * NAL unit behind its own length with the parameter sets stated once. So the
 * bytes around each coded picture are rewritten by design.
 *
 * What is still exactly true, and what is therefore asserted below, is one
 * level down: EVERY NAL UNIT'S PAYLOAD IS IDENTICAL. `nalsOf` pulls the units
 * back out of the finished MP4 through their length prefixes and compares them
 * to the ones that went in. That is the real claim - nothing was decoded and
 * no coefficient moved - and it is a stronger assertion than comparing whole
 * samples would be, because it also proves the lengths are right.
 *
 * The second thing several of these are about is TIME. This is the one
 * container here that states both a decode and a presentation time, so nothing
 * is derived - and it is also the one whose streams do not start together,
 * which is where the interesting failure lives.
 */

const PID_VIDEO = 0x0100;
const PID_AUDIO = 0x0101;

/** Pulls the length-prefixed NAL units back out of one finished MP4 sample. */
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

interface ReadBack {
  readonly tracks: {
    readonly kind: string;
    readonly width: number | null;
    readonly height: number | null;
    readonly sync: readonly number[];
    readonly config: Uint8Array | null;
    readonly samples: Uint8Array[];
    readonly editCount: number;
    readonly firstEdit: number;
  }[];
}

/** Reads a finished MP4 back through this tool's own ISO-BMFF reader. */
function readBack(bytes: Uint8Array): ReadBack {
  const read = readIsoBmff(sourceOf(bytes));
  if (!read.ok) throw new Error(`the output could not be read back: ${read.error.message}`);

  return {
    tracks: read.value.tracks.map((track) => {
      const samples: Uint8Array[] = [];
      for (let index = 0; index < track.samples.count; index += 1) {
        const at = track.samples.offset[index] ?? 0;
        samples.push(bytes.subarray(at, at + (track.samples.size[index] ?? 0)));
      }
      return {
        kind: track.kind,
        width: track.width,
        height: track.height,
        sync: track.samples.sync,
        config: configIn(track.sampleEntry),
        samples,
        editCount: track.edits.length,
        firstEdit: track.edits[0]?.segmentDuration ?? 0,
      };
    }),
  };
}

/** Finds the `avcC` or `hvcC` inside a copied sample entry. */
function configIn(entry: Uint8Array | null): Uint8Array | null {
  if (entry === null) return null;
  const text = new TextDecoder('latin1').decode(entry);
  for (const tag of ['avcC', 'hvcC']) {
    const at = text.indexOf(tag);
    if (at < 0) continue;
    const size =
      (entry[at - 4] ?? 0) * 0x1000000 +
      ((entry[at - 3] ?? 0) << 16) +
      ((entry[at - 2] ?? 0) << 8) +
      (entry[at - 1] ?? 0);
    return entry.subarray(at + 4, at - 4 + size);
  }
  return null;
}

function bytesOf(list: readonly Uint8Array[]): number[][] {
  return list.map((item) => [...item]);
}

/* ========================================================================== *
 * The ordinary case: H.264 and AAC
 * ========================================================================== */

describe('repackaging a transport stream', () => {
  const sps = avcSps();
  const pps = avcPps();
  const idr = avcSlice(5, 1, 900);
  const sei = avcSlice(6, 9, 40);
  const frames = [avcSlice(1, 2, 140), avcSlice(1, 3, 155), avcSlice(1, 4, 130)];

  const audioFrames = [adtsFrame(11, 380), adtsFrame(12, 384), adtsFrame(13, 379)];

  const units: TsAccessUnit[] = [
    // A real capture repeats the parameter sets and puts an access-unit
    // delimiter in front of every frame. Both are dropped on the way out.
    {
      pid: PID_VIDEO,
      payload: annexB(avcSlice(9, 0, 1), sps, pps, sei, idr),
      pts: 93_000,
      dts: 90_000,
    },
    {
      pid: PID_VIDEO,
      payload: annexB(avcSlice(9, 0, 1), frames[0] ?? idr),
      pts: 99_000,
      dts: 93_000,
    },
    { pid: PID_VIDEO, payload: annexB(frames[1] ?? idr), pts: 96_000, dts: 96_000 },
    { pid: PID_VIDEO, payload: annexB(frames[2] ?? idr), pts: 102_000, dts: 99_000 },
    {
      pid: PID_AUDIO,
      payload: audioFrames[0] ?? new Uint8Array(0),
      pts: 90_000,
      video: false,
    },
    {
      pid: PID_AUDIO,
      // Two frames in one packet, which is what an audio PES actually holds.
      payload: new Uint8Array([...(audioFrames[1] ?? []), ...(audioFrames[2] ?? [])]),
      pts: 92_090,
      video: false,
    },
  ];

  const source = makeTransportStream({
    streams: [
      { pid: PID_VIDEO, streamType: 0x1b },
      { pid: PID_AUDIO, streamType: 0x0f, language: 'fra' },
    ],
    units,
  });

  it('carries every coded picture across, unit for unit', () => {
    const done = remux(sourceOf(source), 'container');
    if (!done.ok) throw new Error(done.error.message);
    const video = readBack(outputBytes(done.value.bytes)).tracks.find(
      (track) => track.kind === 'video',
    );

    // The parameter sets and the delimiters are gone, the SEI stayed, and
    // every slice is the encoder's own bytes with a length in front of it.
    expect(bytesOf(video?.samples.flatMap(nalsIn) ?? [])).toEqual(
      bytesOf([sei, idr, frames[0] ?? idr, frames[1] ?? idr, frames[2] ?? idr]),
    );
  });

  it('reads both timestamps rather than deriving one', () => {
    /*
     * The second and third frames are shown in the other order from the one
     * they decode in, which is what a B-frame is - and a conforming stream
     * expresses that by running the decode clock a frame ahead of the
     * presentation clock, so every composition offset is positive.
     *
     * This is the assertion that this format needs LESS inference than
     * Matroska rather than more. There, the decode times are reconstructed by
     * sorting the presentation times, and getting it wrong shows up as frames
     * subtly out of order. Here both numbers are stated and both are read, so
     * the offsets below are the encoder's own arithmetic and not ours.
     */
    const read = readMpegTs(sourceOf(source));
    if (!read.ok) throw new Error(read.error.message);
    const video = read.value.tracks.find((track) => track.kind === 'video');
    expect(video?.samples.dts).toEqual([0, 3000, 6000, 9000]);
    const offsets = video?.samples.dts.map((at, index) => (video.samples.cts[index] ?? 0) - at);
    expect(offsets).toEqual([3000, 6000, 0, 3000]);
  });

  it('pushes a decode time that went backwards forward, and says it did', () => {
    /*
     * A recording spliced out of two sources, or one with a chunk missing from
     * the middle. `stts` holds the gap between consecutive samples and a
     * negative gap is written out as zero - a frame of no duration, which a
     * player shows for no time at all. A run of them is a passage that flashes
     * past, in a file that is otherwise perfect.
     */
    const spliced = makeTransportStream({
      streams: [{ pid: PID_VIDEO, streamType: 0x1b }],
      units: [
        { pid: PID_VIDEO, payload: annexB(sps, pps, idr), pts: 900_000, dts: 900_000 },
        { pid: PID_VIDEO, payload: annexB(frames[0] ?? idr), pts: 3000, dts: 3000 },
      ],
    });

    const read = readMpegTs(sourceOf(spliced));
    if (!read.ok) throw new Error(read.error.message);
    const video = read.value.tracks[0];
    expect(video?.samples.dts).toEqual([0, 1]);
    expect(read.value.problem).toContain('earlier than the frame before');
  });

  it('shifts a stream that shows a frame before it decodes, rather than going negative', () => {
    /*
     * A stream is not supposed to state a presentation time earlier than its
     * own decode time, and a damaged or badly muxed one does. `ctts` version 0
     * cannot hold a negative offset, and version 1 - which can - is read
     * differently or not at all by older players. So the whole file is moved
     * later by the worst overshoot, by the same amount on every track, which
     * is what stops the correction moving sound relative to picture.
     */
    const skewed = makeTransportStream({
      streams: [{ pid: PID_VIDEO, streamType: 0x1b }],
      units: [
        { pid: PID_VIDEO, payload: annexB(sps, pps, idr), pts: 90_000, dts: 90_000 },
        { pid: PID_VIDEO, payload: annexB(frames[0] ?? idr), pts: 90_500, dts: 93_000 },
      ],
    });

    const read = readMpegTs(sourceOf(skewed));
    if (!read.ok) throw new Error(read.error.message);
    const video = read.value.tracks[0];
    const offsets = video?.samples.dts.map((at, index) => (video.samples.cts[index] ?? 0) - at);
    expect(offsets?.every((offset) => offset >= 0)).toBe(true);
  });

  it('marks only the frames a player may actually seek to', () => {
    const done = remux(sourceOf(source), 'container');
    if (!done.ok) throw new Error(done.error.message);
    const video = readBack(outputBytes(done.value.bytes)).tracks.find(
      (track) => track.kind === 'video',
    );
    // The first frame holds an IDR and the rest do not. Marking them all is
    // the plausible wrong answer: it plays from the start and cannot be
    // scrubbed, which is the failure `manual-checks.md` step 3 exists for.
    expect(video?.sync).toEqual([1, 0, 0, 0]);
  });

  it('builds a configuration record whose profile is the stream’s own', () => {
    const done = remux(sourceOf(source), 'container');
    if (!done.ok) throw new Error(done.error.message);
    const video = readBack(outputBytes(done.value.bytes)).tracks.find(
      (track) => track.kind === 'video',
    );
    const config = video?.config;

    expect(config?.[0]).toBe(1); // configurationVersion
    expect(config?.[1]).toBe(66); // Baseline, copied out of the SPS
    expect(config?.[3]).toBe(30); // level 3.0, likewise
    // The parameter sets themselves are in there, verbatim.
    expect([...(config ?? new Uint8Array(0)).subarray(8, 8 + sps.byteLength)]).toEqual([...sps]);
  });

  it('reads the picture size out of the parameter set, since nothing else states it', () => {
    const done = remux(sourceOf(source), 'container');
    if (!done.ok) throw new Error(done.error.message);
    const video = readBack(outputBytes(done.value.bytes)).tracks.find(
      (track) => track.kind === 'video',
    );
    /*
     * THE FAILURE THIS EXISTS FOR. A transport stream states no picture size
     * anywhere, so an `mp4` written without parsing the SPS gets a track
     * header of 0 by 0 - which plays perfectly in QuickTime, because it reads
     * the size out of the stream, and lays out at zero pixels in a browser,
     * which does not. No error, no black frame: nothing at all.
     */
    expect([video?.width, video?.height]).toEqual([640, 480]);
  });

  it('strips the ADTS header and states the configuration once instead', () => {
    const done = remux(sourceOf(source), 'container');
    if (!done.ok) throw new Error(done.error.message);
    const audio = readBack(outputBytes(done.value.bytes)).tracks.find(
      (track) => track.kind === 'audio',
    );

    // Every sample is the raw AAC frame, seven header bytes shorter than the
    // frame that arrived. Leaving them in produces a track whose every sample
    // begins with garbage as far as a decoder is concerned.
    expect(audio?.samples.map((sample) => sample.byteLength)).toEqual([380, 384, 379]);
    expect(bytesOf(audio?.samples ?? [])).toEqual(
      bytesOf([sampleBytes(11, 380), sampleBytes(12, 384), sampleBytes(13, 379)]),
    );
  });

  it('builds the AudioSpecificConfig from the fields the ADTS header states', () => {
    const read = readMpegTs(sourceOf(source));
    if (!read.ok) throw new Error(read.error.message);
    const audio = read.value.tracks.find((track) => track.kind === 'audio');
    // AAC-LC, sampling frequency index 4 (44.1 kHz), two channels - the same
    // three numbers the header carried, moved rather than inferred.
    expect([...(audio?.codecPrivate ?? [])]).toEqual([0x12, 0x10]);
    expect(audio?.sampleRate).toBe(44_100);
    expect(audio?.channels).toBe(2);
  });

  it('finds the frames inside one packet rather than treating the packet as one', () => {
    // The second PES packet holds two AAC frames. A reader that indexed the
    // packet would produce two samples instead of three, all the audio would
    // be present, and the track would be a third too short.
    const read = readMpegTs(sourceOf(source));
    if (!read.ok) throw new Error(read.error.message);
    const audio = read.value.tracks.find((track) => track.kind === 'audio');
    expect(audio?.samples.count).toBe(3);
    // 1024 samples apart, exactly, rather than jittering with the 90 kHz
    // rounding in the timestamps the stream stated.
    expect(audio?.samples.dts).toEqual([0, 1024, 2048]);
  });

  it('names the language a broadcaster put on the track', () => {
    const read = readMpegTs(sourceOf(source));
    if (!read.ok) throw new Error(read.error.message);
    expect(read.value.tracks.find((track) => track.kind === 'audio')?.language).toBe('fra');
  });

  it('says that the framing was rebuilt, because "byte for byte" stops being true', () => {
    const done = remux(sourceOf(source), 'container');
    if (!done.ok) throw new Error(done.error.message);
    expect(done.value.notes.some((note) => note.title.includes('framing was rebuilt'))).toBe(true);
  });
});

/* ========================================================================== *
 * The two shapes a file arrives in
 * ========================================================================== */

describe('finding the packet grid', () => {
  const unit: TsAccessUnit = {
    pid: PID_VIDEO,
    payload: annexB(avcSps(), avcPps(), avcSlice(5, 1, 400)),
    pts: 0,
    dts: 0,
  };
  const streams = [{ pid: PID_VIDEO, streamType: 0x1b }];

  it('reads the AVCHD form, whose packets are 192 bytes with a timestamp in front', () => {
    // Every AVCHD camcorder writes this. Refusing it while accepting `.ts`
    // would turn away the largest single group of files this reader is for.
    const source = makeTransportStream({ streams, units: [unit], packetSize: 192 });
    const read = readMpegTs(sourceOf(source));
    if (!read.ok) throw new Error(read.error.message);
    expect(read.value.flavour).toBe('MPEG-TS (AVCHD)');
    expect(read.value.tracks[0]?.samples.count).toBe(1);
  });

  it('finds the grid in a file that begins partway through a packet', () => {
    // A transport stream has no beginning: a recorder writes whatever it had
    // buffered, so the first byte is 0x47 only by luck.
    const source = makeTransportStream({ streams, units: [unit], leading: 91 });
    const read = readMpegTs(sourceOf(source));
    if (!read.ok) throw new Error(read.error.message);
    expect(read.value.tracks[0]?.samples.count).toBe(1);
  });
});

/* ========================================================================== *
 * Time, which is where the interesting failure is
 * ========================================================================== */

describe('two streams that do not start together', () => {
  /*
   * THE FAILURE THIS DESCRIBE BLOCK EXISTS FOR, and it is the one worth being
   * uncomfortable about.
   *
   * An MP4's `stts` holds the gap between one sample and the next, so a
   * track's first sample is at media time zero by construction - there is no
   * field for "this track starts a tenth of a second late". In an MP4 or a
   * Matroska file that never comes up, because tracks start together. In a
   * transport stream they routinely do not.
   *
   * Drop the difference and the file plays, is the right length, and has the
   * sound out of step with the picture by exactly the discarded offset for its
   * entire duration. It looks like a bad encode rather than a bad remux, which
   * is why it needs a test rather than a paragraph.
   */
  const video: TsAccessUnit[] = [0, 3000, 6000].map((step) => ({
    pid: PID_VIDEO,
    payload: annexB(avcSps(), avcPps(), avcSlice(step === 0 ? 5 : 1, 20 + step, 300)),
    pts: 90_000 + step,
    dts: 90_000 + step,
  }));

  // A tenth of a second after the video, which is an ordinary offset for a
  // tuner recording and is well inside what a person hears as lip-sync.
  const audio: TsAccessUnit[] = [0, 1, 2].map((index) => ({
    pid: PID_AUDIO,
    payload: adtsFrame(30 + index, 200),
    pts: 99_000 + Math.round((index * 1024 * 90_000) / 44_100),
    video: false,
  }));

  const source = makeTransportStream({
    streams: [
      { pid: PID_VIDEO, streamType: 0x1b },
      { pid: PID_AUDIO, streamType: 0x0f },
    ],
    units: [...video, ...audio],
  });

  it('holds the offset between them in an edit list rather than losing it', () => {
    const done = remux(sourceOf(source), 'container');
    if (!done.ok) throw new Error(done.error.message);
    const tracks = readBack(outputBytes(done.value.bytes)).tracks;

    const picture = tracks.find((track) => track.kind === 'video');
    const sound = tracks.find((track) => track.kind === 'audio');

    // The video is the earlier of the two, so it starts at zero with nothing
    // to express; the audio carries an empty edit of a tenth of a second, and
    // a second entry for the media itself. One entry alone would mean "show
    // nothing for a tenth of a second, and then nothing else".
    expect(picture?.editCount).toBe(0);
    expect(sound?.editCount).toBe(2);
    // 9000 ticks of the movie's 90 kHz clock is exactly 0.1 seconds.
    expect(sound?.firstEdit).toBe(9000);
  });

  it('starts both tracks at zero in their own media time', () => {
    // Which is the other half of the same decision: the timestamps in a
    // transport stream start wherever the transmitter's clock was, and 90,000
    // ticks of leading offset inside `stts` is a second of nothing.
    const read = readMpegTs(sourceOf(source));
    if (!read.ok) throw new Error(read.error.message);
    for (const track of read.value.tracks) {
      expect(track.samples.dts[0]).toBe(0);
    }
  });
});

/* ========================================================================== *
 * The other codecs
 * ========================================================================== */

describe('what a transport stream can hold that will not travel', () => {
  it('refuses an encrypted recording rather than repackaging static', () => {
    const source = makeTransportStream({
      streams: [{ pid: PID_VIDEO, streamType: 0x1b }],
      units: [{ pid: PID_VIDEO, payload: annexB(avcSps(), avcPps(), avcSlice(5, 1, 400)) }],
      scrambled: true,
    });

    const done = remux(sourceOf(source), 'container');
    expect(done.ok).toBe(false);
    if (done.ok) return;
    expect(done.error.message).toContain('encrypted');
    // The sentence that makes it useful: what the alternative would have been.
    expect(done.error.detail).toContain('static');
  });

  it('names MPEG-2 video and Dolby Digital, which is what a tuner recording is', () => {
    const source = makeTransportStream({
      streams: [
        { pid: PID_VIDEO, streamType: 0x02 },
        // AC-3 announced through a registration descriptor on a private
        // stream, which is how DVB does it - and is indistinguishable from a
        // teletext page without reading the descriptors.
        { pid: PID_AUDIO, streamType: 0x06, descriptors: [0x6a, 1, 0x00] },
      ],
      units: [
        { pid: PID_VIDEO, payload: sampleBytes(1, 500), pts: 0, dts: 0 },
        { pid: PID_AUDIO, payload: sampleBytes(2, 200), pts: 0, video: false },
      ],
    });

    const done = remux(sourceOf(source), 'container');
    expect(done.ok).toBe(false);
    if (done.ok) return;
    expect(done.error.detail).toContain('MPEG-2 video');
    expect(done.error.detail).toContain('Dolby Digital');
  });

  it('tells Layer II from Layer III, because only one of them travels', () => {
    // Both arrive as stream type 0x03 or 0x04. The layer is in the frame
    // header, so a reader that trusts the table calls a European broadcast's
    // Layer II audio an MP3 and writes a track nothing will decode.
    const source = makeTransportStream({
      streams: [{ pid: PID_AUDIO, streamType: 0x03 }],
      units: [
        {
          pid: PID_AUDIO,
          payload: new Uint8Array([
            ...mpegAudioFrameBytes(41, true),
            ...mpegAudioFrameBytes(42, true),
          ]),
          pts: 0,
          video: false,
        },
      ],
    });

    const read = readMpegTs(sourceOf(source));
    if (!read.ok) throw new Error(read.error.message);
    expect(read.value.tracks[0]?.codec).toBe('mp2');

    const done = remux(sourceOf(source), 'audio');
    expect(done.ok).toBe(false);
    if (done.ok) return;
    expect(done.error.detail).toContain('Layer II');
  });

  it('lifts Layer III out as a bare stream, frame for frame', () => {
    const frames = [mpegAudioFrameBytes(51), mpegAudioFrameBytes(52), mpegAudioFrameBytes(53)];
    const source = makeTransportStream({
      streams: [{ pid: PID_AUDIO, streamType: 0x04 }],
      units: [
        // Deliberately split so that the second frame straddles two PES
        // packets: an MP3 frame's boundary has nothing to do with a packet's.
        {
          pid: PID_AUDIO,
          payload: new Uint8Array([...(frames[0] ?? new Uint8Array(0)), 0xff, 0xfb]),
          pts: 0,
          video: false,
        },
        {
          pid: PID_AUDIO,
          payload: new Uint8Array([
            ...(frames[1] ?? new Uint8Array(0)).subarray(2),
            ...(frames[2] ?? new Uint8Array(0)),
          ]),
          pts: 2611,
          video: false,
        },
      ],
    });

    const done = remux(sourceOf(source), 'audio');
    if (!done.ok) throw new Error(done.error.message);
    expect(done.value.extension).toBe('mp3');
    expect([...outputBytes(done.value.bytes)]).toEqual([
      ...(frames[0] ?? []),
      ...(frames[1] ?? []),
      ...(frames[2] ?? []),
    ]);
  });

  it('says how many other programmes were in the multiplex', () => {
    const source = makeTransportStream({
      streams: [{ pid: PID_VIDEO, streamType: 0x1b }],
      units: [
        {
          pid: PID_VIDEO,
          payload: annexB(avcSps(), avcPps(), avcSlice(5, 1, 400)),
          pts: 0,
          dts: 0,
        },
      ],
      extraPrograms: 4,
    });

    const done = remux(sourceOf(source), 'container');
    if (!done.ok) throw new Error(done.error.message);
    expect(done.value.from.metadata).toEqual(['4 other programmes in the multiplex']);
  });

  it('refuses a fragment that holds tables and no frames', () => {
    const source = makeTransportStream({
      streams: [{ pid: PID_VIDEO, streamType: 0x1b }],
      units: [],
    });
    const done = remux(sourceOf(source), 'container');
    expect(done.ok).toBe(false);
    if (done.ok) return;
    expect(done.error.message).toContain('no frames');
  });

  it('drops a video track whose parameter sets never arrived, and says which', () => {
    // A capture that began mid-GOP: slices, and nothing that says how to
    // decode them. Writing the track anyway produces a file that looks
    // complete and shows nothing.
    const source = makeTransportStream({
      streams: [
        { pid: PID_VIDEO, streamType: 0x1b },
        { pid: PID_AUDIO, streamType: 0x0f },
      ],
      units: [
        { pid: PID_VIDEO, payload: annexB(avcSlice(1, 1, 300)), pts: 0, dts: 0 },
        { pid: PID_AUDIO, payload: adtsFrame(61, 200), pts: 0, video: false },
      ],
    });

    const done = remux(sourceOf(source), 'container');
    if (!done.ok) throw new Error(done.error.message);
    // Audio survives, and the result is named as audio rather than pretending
    // to be a video - the same salvage the Matroska reader's missing
    // `CodecPrivate` case gets, because in both the FILE is what is broken.
    expect(done.value.extension).toBe('m4a');
    expect(done.value.notes.some((note) => note.title.includes('no decoder configuration'))).toBe(
      true,
    );
  });
});

/* ========================================================================== *
 * H.265, and the one parameter set that has to be parsed properly
 * ========================================================================== */

describe('H.265 out of a transport stream', () => {
  const vps = hevcVps();
  const sps = hevcSps();
  const pps = hevcPps();
  const idr = hevcSlice(19, 1, 800); // IDR_W_RADL
  const trail = hevcSlice(1, 2, 200); // TRAIL_R

  const source = makeTransportStream({
    streams: [{ pid: PID_VIDEO, streamType: 0x24 }],
    units: [
      { pid: PID_VIDEO, payload: annexB(vps, sps, pps, idr), pts: 0, dts: 0 },
      { pid: PID_VIDEO, payload: annexB(trail), pts: 3000, dts: 3000 },
    ],
  });

  it('builds an hvcC whose profile, tier and level are the stream’s own', () => {
    const done = remux(sourceOf(source), 'container');
    if (!done.ok) throw new Error(done.error.message);
    const config = readBack(outputBytes(done.value.bytes)).tracks[0]?.config;

    /*
     * The twelve bytes this asserts are the reason `readHevcSps` exists. Every
     * one of them sits behind a variable-length field, so there is no way to
     * reach them by counting bytes - and a wrong value produces a file VLC
     * plays and Safari shows as a black frame, which presents as a Safari bug.
     */
    expect(config?.[0]).toBe(1); // configurationVersion
    expect(config?.[1]).toBe(0x01); // profile space 0, main tier, profile 1
    expect(config?.[2]).toBe(0x60); // the top byte of the compatibility flags
    expect(config?.[6]).toBe(0xb0); // the first constraint-flag byte
    expect(config?.[12]).toBe(120); // level 4.0
    // Three fields declared unknown rather than guessed, which the format
    // allows: min_spatial_segmentation_idc, then parallelismType.
    expect([config?.[13], config?.[14], config?.[15]]).toEqual([0xf0, 0x00, 0xfc]);
    // Then chroma 4:2:0 and eight bits deep, in the three bytes that state them.
    expect(config?.[16]).toBe(0xfd);
    expect(config?.[17]).toBe(0xf8);
    expect(config?.[18]).toBe(0xf8);
  });

  it('reads the picture size, which H.265 states in luma samples', () => {
    const done = remux(sourceOf(source), 'container');
    if (!done.ok) throw new Error(done.error.message);
    const track = readBack(outputBytes(done.value.bytes)).tracks[0];
    expect([track?.width, track?.height]).toEqual([1280, 720]);
  });

  it('treats a random-access picture as a seek point and a trailing one as not', () => {
    const done = remux(sourceOf(source), 'container');
    if (!done.ok) throw new Error(done.error.message);
    expect(readBack(outputBytes(done.value.bytes)).tracks[0]?.sync).toEqual([1, 0]);
  });

  it('carries the video parameter set, which H.264 has no equivalent of', () => {
    const done = remux(sourceOf(source), 'container');
    if (!done.ok) throw new Error(done.error.message);
    const config = readBack(outputBytes(done.value.bytes)).tracks[0]?.config ?? new Uint8Array(0);
    const text = [...config].join(',');
    expect(text).toContain([...vps].join(','));
    expect(text).toContain([...sps].join(','));
    expect(text).toContain([...pps].join(','));
  });
});

/* ========================================================================== *
 * The cropping case
 * ========================================================================== */

describe('a 1080p stream, which is coded 1088 lines tall', () => {
  it('subtracts the crop in chroma samples rather than in pixels', () => {
    /*
     * 1080 is not a multiple of sixteen, so every 1080p encoder codes 1088
     * lines and crops eight - and writes FOUR in the parameter set, because
     * the crop is counted in chroma samples and this is 4:2:0.
     *
     * A reader that subtracts it as pixels reports 1084, which is not obviously
     * wrong to anybody reading a report and is a track header that stretches
     * every frame by four lines' worth.
     */
    const source = makeTransportStream({
      streams: [{ pid: PID_VIDEO, streamType: 0x1b }],
      units: [
        {
          pid: PID_VIDEO,
          payload: annexB(avcSpsHigh(), avcPps(), avcSlice(5, 1, 900)),
          pts: 0,
          dts: 0,
        },
      ],
    });

    const done = remux(sourceOf(source), 'container');
    if (!done.ok) throw new Error(done.error.message);
    const track = readBack(outputBytes(done.value.bytes)).tracks[0];
    expect([track?.width, track?.height]).toEqual([1920, 1080]);
  });

  it('writes the three high-profile bytes an older muxer would have left off', () => {
    const source = makeTransportStream({
      streams: [{ pid: PID_VIDEO, streamType: 0x1b }],
      units: [
        {
          pid: PID_VIDEO,
          payload: annexB(avcSpsHigh(), avcPps(), avcSlice(5, 1, 900)),
          pts: 0,
          dts: 0,
        },
      ],
    });

    const done = remux(sourceOf(source), 'container');
    if (!done.ok) throw new Error(done.error.message);
    const config: Uint8Array =
      readBack(outputBytes(done.value.bytes)).tracks[0]?.config ?? new Uint8Array(0);
    // The last four bytes: chroma format 1, both bit depths 8, no extensions.
    expect([...config.subarray(-4)]).toEqual([0xfd, 0xf8, 0xf8, 0x00]);
  });
});
