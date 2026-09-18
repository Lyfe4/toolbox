#!/usr/bin/env node
/**
 * Generates a REAL video for `check:browsers` to play, and the frames a real
 * decoder gets out of it.
 *
 * WHY. `docs/manual-checks.md` has carried the same line since the video tool
 * landed: "nothing here has ever played a file that tool made." Everything in
 * the suite is about bytes - the coded pictures survive, the index is in front
 * of the media, the parameter set says 640x480 - and every one of those can be
 * true of a file no player will open. A container is a contract with a
 * decoder, and the only way to check a contract with a decoder is to ask one.
 *
 * WHY A FIXTURE AND NOT ffmpeg AT CHECK TIME. `check:browsers` already needs
 * 165 MB of browser binaries; needing a 90 MB encoder on top would make it a
 * check that does not run. The clip below is produced ONCE, by a real encoder,
 * and committed - so the harness ships a file this repository did not write,
 * which is the whole point: a fixture we assembled by hand proves that our
 * writer agrees with our reader.
 *
 * WHAT IS IN IT. Twelve frames at 320x240, each a flat, unmistakable colour, so
 * a decoded frame can be identified from one pixel and a frame served in the
 * wrong order or dropped is visible rather than subtle. Encoded with
 * `-g 1` - every frame a keyframe - because the tool's own README says a
 * remuxer moves coded pictures without reordering them, and an all-keyframe
 * clip is the one where "frame 6 is the sixth colour" is a claim about the
 * container rather than about a decoder's reference buffers.
 *
 * Regenerate with (ffmpeg on PATH, or FFMPEG=... pointing at one):
 *
 *     node scripts/generate-video-playback-fixture.mjs > src/tools/video-remux/spec/playback.json && pnpm format
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FFMPEG = process.env.FFMPEG ?? 'ffmpeg';
const FFPROBE = process.env.FFPROBE ?? 'ffprobe';

const WIDTH = 320;
const HEIGHT = 240;

/**
 * One flat colour per frame, chosen so that no two are within 40 levels of each
 * other on any channel - a decoded frame has to be identified by a pixel, and
 * two colours a hair apart would make that identification an accident.
 */
const FRAMES = [
  [220, 20, 20],
  [20, 200, 20],
  [20, 20, 220],
  [230, 230, 20],
  [20, 220, 220],
  [220, 20, 220],
  [250, 250, 250],
  [10, 10, 10],
  [250, 140, 20],
  [140, 20, 250],
  [20, 140, 140],
  [140, 140, 20],
];

const work = mkdtempSync(join(tmpdir(), 'patchbay-playback-'));

try {
  /* -- One PNG per frame, so the encoder is fed exact colours -------------- */

  const inputs = [];
  for (const [index, [r, g, b]] of FRAMES.entries()) {
    const path = join(work, `frame-${String(index).padStart(3, '0')}.png`);
    execFileSync(FFMPEG, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      `color=c=0x${[r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('')}:s=${String(WIDTH)}x${String(HEIGHT)}`,
      '-frames:v',
      '1',
      '-y',
      path,
    ]);
    inputs.push(path);
  }

  /* -- A real H.264 MP4 --------------------------------------------------- */

  const mp4 = join(work, 'clip.mp4');
  execFileSync(FFMPEG, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-framerate',
    '12',
    '-i',
    join(work, 'frame-%03d.png'),
    '-c:v',
    'libx264',
    // Every frame a keyframe, and no B-frames: presentation order is coding
    // order, so "the sixth frame is the sixth colour" is about the container.
    '-g',
    '1',
    '-bf',
    '0',
    '-pix_fmt',
    'yuv420p',
    // Constant quality rather than a bitrate: flat colours compress to almost
    // nothing, and this keeps the committed fixture small without smearing the
    // colours the check identifies frames by.
    '-crf',
    '18',
    '-preset',
    'veryslow',
    // faststart is deliberately NOT used: the tool's own claim is that it moves
    // the index in front of the media, and a source that already had it there
    // would make that check unfalsifiable.
    '-y',
    mp4,
  ]);

  const bytes = readFileSync(mp4);

  /* -- What a real decoder gets out of it --------------------------------- */

  /*
   * The frames as the ENCODER'S OWN decoder sees them, not as they were sent
   * in. H.264 at crf 18 in 4:2:0 does not return the exact RGB that went in,
   * and the browser check compares against what a decoder produces rather than
   * against the colours above - so this is the number that matters and it is
   * measured rather than assumed.
   */
  const raw = join(work, 'decoded.rgba');
  execFileSync(FFMPEG, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    mp4,
    '-pix_fmt',
    'rgba',
    '-f',
    'rawvideo',
    '-y',
    raw,
  ]);

  const decoded = readFileSync(raw);
  const frameBytes = WIDTH * HEIGHT * 4;
  if (decoded.length !== frameBytes * FRAMES.length) {
    throw new Error(
      `decoded ${String(decoded.length / frameBytes)} frames, expected ${String(FRAMES.length)}`,
    );
  }

  /** The centre pixel of each decoded frame: what the browser check compares. */
  const centres = FRAMES.map((_, index) => {
    const at = index * frameBytes + ((HEIGHT / 2) * WIDTH + WIDTH / 2) * 4;
    return [decoded[at], decoded[at + 1], decoded[at + 2]];
  });

  /*
   * THE FIXTURE HAS TO BE ABLE TO TELL FRAMES APART, or every assertion built
   * on it is satisfied by a player showing frame one twelve times.
   */
  for (let a = 0; a < centres.length; a += 1) {
    for (let b = a + 1; b < centres.length; b += 1) {
      const apart = Math.max(
        ...[0, 1, 2].map((channel) => Math.abs(centres[a][channel] - centres[b][channel])),
      );
      if (apart < 40) {
        throw new Error(
          `decoded frames ${String(a)} and ${String(b)} are only ${String(apart)} levels apart`,
        );
      }
    }
  }

  /** And what the container says, from a demuxer that is not ours. */
  const probe = JSON.parse(
    execFileSync(FFPROBE, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-show_streams',
      '-show_format',
      '-of',
      'json',
      mp4,
    ]),
  );
  const video = probe.streams.find((stream) => stream.codec_type === 'video');

  const version = execFileSync(FFMPEG, ['-hide_banner', '-version'])
    .toString('utf8')
    .split('\n')[0];

  process.stdout.write(
    `${JSON.stringify(
      {
        generator: 'a real H.264 clip, encoded once and committed',
        encoder: version,
        clip: {
          name: 'colours.mp4',
          width: WIDTH,
          height: HEIGHT,
          frames: FRAMES.length,
          frameRate: 12,
          bytes: bytes.length,
          mp4Base64: bytes.toString('base64'),
        },
        container: {
          codec: video?.codec_name,
          profile: video?.profile,
          pixelFormat: video?.pix_fmt,
          declaredWidth: video?.width,
          declaredHeight: video?.height,
          durationSeconds: Number(probe.format?.duration),
        },
        /**
         * The colours a decoder returns, which are not the ones encoded.
         *
         * Recorded rather than asserted, and it is the reason the browser check
         * compares the output against the SOURCE in one engine instead of
         * against these: Gecko returns rgb(237, 39, 19) where ffmpeg returns
         * rgb(219, 18, 18) for the same coded frame. That is a decoder's
         * YUV-to-RGB matrix, which is not a remuxer's business.
         */
        decodedCentres: centres,
        /** The colours that went in, kept so the drift is visible in review. */
        encodedCentres: FRAMES,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
