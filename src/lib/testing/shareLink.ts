import { encodeBase64 } from '@/lib/base64';

/**
 * Encodes an arbitrary payload the way an older build's share encoder would.
 *
 * Built by hand rather than with `encodeGraphToParam`, because that can only
 * ever produce the CURRENT format - and a link from an older one is exactly
 * what a migration test needs. The compression stream is assembled explicitly
 * because jsdom's `Blob` has no `stream()`, which is the same reason `share.ts`
 * has its own `streamOf`.
 *
 * SHARED, because two suites need it: the retired-TOOL migration (v1 -> v2) and
 * the retired-PORT migration (v2 -> v3). It lived in the first of those, and a
 * copy in the second would be two hand-rolled deflate streams to keep in step.
 */
export async function legacyShareLink(payload: unknown): Promise<string> {
  const source = new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(JSON.stringify(payload)));
      controller.close();
    },
  });

  const reader = source.pipeThrough(new CompressionStream('deflate-raw')).getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }

  return encodeBase64(bytes, { urlSafe: true, padding: false, wrapAt: 0 });
}
