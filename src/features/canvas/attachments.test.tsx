import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ToastProvider } from '@/components/Toast';
import type { ExecuteOptions } from '@/features/execution/engine';
import { usePipelineStore } from '@/features/execution/pipelineStore';
import { getManifestEntry } from '@/features/registry';
import type { InputPort, ToolOutputs, ToolResult } from '@/features/registry/types';
import { EMPTY_ANNOUNCEMENTS } from '@/lib/announce';
import { materialiseBinary, type BinaryData } from '@/lib/binary';
import { loadFileForPort, type LoadedFile } from '@/lib/fileInput';
import { expectNoAxeViolations } from '@/lib/testing/axe';

import { useAttachmentStore } from './attachmentStore';
import { Canvas } from './Canvas';
import { useCanvasStore } from './graphStore';
import { toPersisted } from './persistence';
import { toSharePayload } from './share';
import { EMPTY_GRAPH, type CanvasEdge, type CanvasNode } from './types';
import { DEFAULT_VIEWPORT, useViewportStore } from './viewportStore';

/**
 * A FILE AS A NODE'S INPUT.
 *
 * You could not put a file on the canvas. No node had a file control, so the
 * only way to get bytes into a pipeline was to decode base64 - which meant
 * "hash this file" and "convert this image", the two things those tools exist
 * for, could not be STARTED on the canvas at all. The tool page had accepted a
 * dropped file since it was written; the canvas never had.
 *
 * Every test here names the behaviour it exists to hold, and the ones about
 * reload and share links are the ones to read first: a file is deliberately
 * session state, and what happens when the session ends had to be an answer
 * rather than a crash or a silently empty node.
 *
 * WHAT THIS FILE CANNOT SEE. jsdom has no layout, no real file picker and no
 * `DataTransfer` with a live file list, so the drop gesture is driven by
 * dispatching events with a stubbed `dataTransfer`, and the 44px target and the
 * drop highlight are measured in `scripts/cross-browser-check.mjs` instead.
 */

function renderCanvas() {
  return render(
    <ToastProvider>
      <Canvas />
    </ToastProvider>,
  );
}

function node(
  id: string,
  toolId: CanvasNode['toolId'],
  x = 0,
  y = 0,
  extra: Partial<CanvasNode> = {},
): CanvasNode {
  return { id, toolId, position: { x, y }, options: {}, inputs: {}, fileInputs: {}, ...extra };
}

function seed(nodes: readonly CanvasNode[], edges: readonly CanvasEdge[] = []): void {
  usePipelineStore.getState().reset();
  useCanvasStore.setState({
    graph: {
      nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])),
      nodeOrder: nodes.map((entry) => entry.id),
      edges: Object.fromEntries(edges.map((entry) => [entry.id, entry])),
      edgeOrder: edges.map((entry) => entry.id),
      nextId: nodes.length + edges.length + 1,
    },
    selection: { nodes: [], edges: [] },
    past: [],
    future: [],
    pendingMove: null,
    ...EMPTY_ANNOUNCEMENTS,
  });
}

function select(...ids: readonly string[]): void {
  act(() => {
    useCanvasStore.getState().select({ nodes: [...ids], edges: [] });
  });
}

async function openInspector(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(screen.getByRole('button', { name: 'Inspector' }));
  return screen.getByTestId('node-inspector');
}

function textFile(name: string, text = 'hello'): File {
  return new File([text], name, { type: 'text/plain' });
}

/** A real PNG header, so the sniff calls it an image rather than guessing. */
function pngFile(name = 'photo.png', extra = 0): File {
  const bytes = new Uint8Array(8 + extra);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return new File([bytes], name, { type: 'image/png' });
}

/** Loads a file the way the UI does, for the tests that seed one directly. */
async function loadedFor(toolId: CanvasNode['toolId'], portId: string, file: File) {
  const entry = getManifestEntry(toolId);
  const port: InputPort | undefined = entry.inputs.find((candidate) => candidate.id === portId);
  if (!port) throw new Error(`${toolId} has no port ${portId}`);
  const result = await loadFileForPort(port, file, { maxBytes: entry.execution.maxInputBytes });
  if (!('loaded' in result)) throw new Error(`fixture rejected: ${result.error}`);
  return result.loaded;
}

/** Puts a file on a port exactly as the inspector's handler does. */
async function attach(
  nodeId: string,
  toolId: CanvasNode['toolId'],
  portId: string,
  file: File,
): Promise<LoadedFile> {
  const loaded = await loadedFor(toolId, portId, file);
  act(() => {
    const ref = useAttachmentStore.getState().attach(nodeId, portId, loaded);
    useCanvasStore.getState().setNodeFile(nodeId, portId, ref);
  });
  return loaded;
}

/**
 * Drops a file on an element.
 *
 * jsdom's `DataTransfer` has no writable file list, so the event carries a
 * hand-built one. `bubbles` matters: the listener is on the workspace and the
 * whole design is that a drop anywhere inside it is caught before the browser
 * can navigate to the file.
 */
function dropOn(element: Element, file: File | null): void {
  const dataTransfer = { files: { item: () => file, length: file ? 1 : 0 } };
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
  act(() => {
    element.dispatchEvent(event);
  });
}

function dragOver(element: Element): Event {
  const event = new Event('dragover', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { files: { item: () => null } } });
  act(() => {
    element.dispatchEvent(event);
  });
  return event;
}

function succeedsWith(outputs: ToolOutputs): () => Promise<ToolResult<ToolOutputs>> {
  return () => Promise.resolve<ToolResult<ToolOutputs>>({ ok: true, value: outputs });
}

/** The status word a node prints in its footer, which is one span of its own. */
function statusOf(nodeId: string): string | null {
  return (
    screen.getByTestId(`node-${nodeId}`).querySelector<HTMLElement>('[class*="nodeFooter"] span')
      ?.textContent ?? null
  );
}

function summaryOf(nodeId: string): string {
  const element = screen
    .getByTestId(`node-${nodeId}`)
    .querySelector<HTMLElement>('[class*="nodeSummary"]');
  if (!element) throw new Error(`no summary on ${nodeId}`);
  return element.textContent;
}

beforeEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  usePipelineStore.getState().reset();
  usePipelineStore.setState({ execute: succeedsWith({ output: { type: 'text', text: 'abc' } }) });
  act(() => {
    useAttachmentStore.getState().resetAttachments();
  });
  useCanvasStore.setState({
    graph: EMPTY_GRAPH,
    selection: { nodes: [], edges: [] },
    past: [],
    future: [],
    pendingMove: null,
    ...EMPTY_ANNOUNCEMENTS,
  });
  useViewportStore.setState({ viewport: DEFAULT_VIEWPORT, isPanning: false });
});

/* ========================================================================== *
 * The control, and which ports get one
 * ========================================================================== */

describe('the inspector offers a file on every port that can take one', () => {
  /*
   * THE WHOLE DEFECT, IN ONE ASSERTION. `image-convert` declares
   * `types: ['bytes']` on its only input, so before this there was no way at
   * all to start an image conversion on the canvas: nothing to type into, and
   * a wire could only come from a node whose own input had the same problem.
   */
  it('gives a bytes-only port a file chooser', async () => {
    const user = userEvent.setup();
    seed([node('a', 'image-convert')]);
    renderCanvas();
    select('a');

    const panel = await openInspector(user);
    expect(within(panel).getByLabelText('Choose file')).toBeInTheDocument();
  });

  /*
   * THE FIFTH INSTANCE OF A CONTROL IMPLYING BEHAVIOUR IT DOES NOT HAVE, and
   * the one this change must not reintroduce. A bytes-only port had a textarea
   * on both routes whose every keystroke the engine ignored. Adding a file
   * control to the same port is exactly the moment to assert the box is still
   * absent.
   */
  it('gives a bytes-only port no text box, only the control that works', async () => {
    const user = userEvent.setup();
    seed([node('a', 'image-convert')]);
    renderCanvas();
    select('a');

    const panel = await openInspector(user);
    expect(within(panel).queryByRole('textbox')).not.toBeInTheDocument();
    // The port's own description is the instruction instead.
    expect(within(panel).getByText(/PNG, JPEG, GIF or WebP/i)).toBeInTheDocument();
  });

  it('gives a text port both a box and a chooser', async () => {
    const user = userEvent.setup();
    seed([node('a', 'hash')]);
    renderCanvas();
    select('a');

    const panel = await openInspector(user);
    expect(within(panel).getByRole('textbox', { name: 'Hash input' })).toBeInTheDocument();
    expect(within(panel).getByLabelText('Choose file')).toBeInTheDocument();
  });

  /*
   * ONE CONTROL PER PORT, NOT ONE PER NODE. The tool page sends its single file
   * to "the first port that takes bytes", which is all one control can do - and
   * it makes `diff`'s second document port unreachable by file, so comparing
   * two files is possible on neither route. Two ports, two named controls.
   */
  it('gives a tool with two document ports two distinctly named choosers', async () => {
    const user = userEvent.setup();
    seed([node('a', 'diff')]);
    renderCanvas();
    select('a');

    const panel = await openInspector(user);
    expect(within(panel).getByLabelText('Choose file for Original')).toBeInTheDocument();
    expect(within(panel).getByLabelText('Choose file for Changed')).toBeInTheDocument();
  });

  /*
   * A wire wins over a file exactly as it wins over typed text, so a wired port
   * gets neither control. Drawing one whose contents the run would ignore is
   * the same defect in a different costume.
   */
  it('gives a wired port neither a box nor a chooser', async () => {
    const user = userEvent.setup();
    seed(
      [node('a', 'base64'), node('b', 'hash', 400, 0)],
      [{ id: 'e1', from: { nodeId: 'a', portId: 'output' }, to: { nodeId: 'b', portId: 'input' } }],
    );
    renderCanvas();
    select('b');

    const panel = await openInspector(user);
    expect(within(panel).getByText(/Wired from Base64/)).toBeInTheDocument();
    expect(within(panel).queryByLabelText('Choose file')).not.toBeInTheDocument();
    expect(within(panel).queryByRole('textbox', { name: 'Hash input' })).not.toBeInTheDocument();
  });

  it('has no axe violations with a file control and a chosen file on screen', async () => {
    const user = userEvent.setup();
    seed([node('a', 'diff')]);
    renderCanvas();
    await attach('a', 'diff', 'original', textFile('left.txt'));
    select('a');

    await openInspector(user);
    // The whole document: the panel is a sibling of the canvas root, so a
    // container-scoped run would miss the relationship between the two.
    await expectNoAxeViolations(document.body);
  });
});

/* ========================================================================== *
 * Choosing one, and what happens next
 * ========================================================================== */

describe('choosing a file', () => {
  /*
   * ANNOUNCED BY THE PORT'S LABEL, NOT ITS ID. "A port id is an identity; a
   * label is a word for a person" is the port audit's own rule, and this string
   * is read aloud - `Loaded left.txt into original.` is the id leaking into a
   * sentence a screen reader speaks. `diff` is the tool that can tell them
   * apart: its ports are `original`/`Original` and `changed`/`Changed`.
   *
   * Driven through the real control rather than by announcing the sentence and
   * then asserting it, which would be a test of nothing.
   */
  it('announces the file and the port by name, not by port id', async () => {
    const user = userEvent.setup();
    seed([node('a', 'diff')]);
    renderCanvas();
    select('a');

    const panel = await openInspector(user);
    await user.upload(
      within(panel).getByLabelText('Choose file for Original'),
      textFile('left.txt', 'alpha'),
    );

    await waitFor(() => {
      const spoken = useCanvasStore
        .getState()
        .announcementLog.map((entry) => entry.text)
        .join(' | ');
      expect(spoken).toContain('Loaded left.txt · 5 B into Original. Nothing is uploaded.');
    });

    await user.click(within(panel).getByRole('button', { name: 'Remove left.txt' }));

    await waitFor(() => {
      const spoken = useCanvasStore
        .getState()
        .announcementLog.map((entry) => entry.text)
        .join(' | ');
      expect(spoken).toContain('Removed the file from Original.');
    });
  });

  it('records the name and size in the document and the bytes in the session', async () => {
    seed([node('a', 'hash')]);
    renderCanvas();
    await attach('a', 'hash', 'input', textFile('notes.txt', 'hello'));

    const stored = useCanvasStore.getState().graph.nodes.a?.fileInputs.input;
    expect(stored).toMatchObject({ name: 'notes.txt', size: 5 });
    expect(useAttachmentStore.getState().valueFor('a', 'input')).toMatchObject({ type: 'bytes' });
  });

  /*
   * The file reaches the tool. Asserted against what the executor was actually
   * handed rather than against a rendered digest, because the point is that the
   * BYTES made it across the boundary the engine builds inputs at.
   */
  it('hands the file to the tool as the value for its port', async () => {
    const calls: ExecuteOptions[] = [];
    usePipelineStore.setState({
      execute: (options) => {
        calls.push(options);
        return Promise.resolve<ToolResult<ToolOutputs>>({
          ok: true,
          value: { output: { type: 'text', text: 'digest' } },
        });
      },
    });

    seed([node('a', 'hash')]);
    renderCanvas();
    await attach('a', 'hash', 'input', textFile('notes.txt', 'hello'));

    await waitFor(() => {
      expect(calls.some((call) => call.inputs.input?.type === 'bytes')).toBe(true);
    });
    const call = calls.find((entry) => entry.inputs.input?.type === 'bytes');
    const value = call?.inputs.input;
    if (value?.type !== 'bytes') throw new Error('the tool was handed no bytes');

    /*
     * READ THROUGH THE VALUE, because the value no longer holds the bytes: a
     * file chosen for a `bytes` port is now a reference to the file on disk,
     * and what this test has always been about is that the TOOL gets the
     * content. Materialising here is what the harness does for a resident
     * tool, so this asserts the same thing one step earlier.
     */
    expect(Array.from(await materialiseBinary(value.data))).toEqual([104, 101, 108, 108, 111]);
    expect(value.filename).toBe('notes.txt');
  });

  /*
   * A FILE OUTRANKS TYPED TEXT, and the box goes rather than being disabled -
   * the inspector's own rule for a port whose winner is decided. The text is
   * not destroyed, which is the other half of the promise.
   */
  it('replaces the text box, and gives it back with its text when the file goes', async () => {
    const user = userEvent.setup();
    seed([node('a', 'hash', 0, 0, { inputs: { input: 'typed earlier' } })]);
    renderCanvas();
    select('a');

    const panel = await openInspector(user);
    expect(within(panel).getByRole('textbox', { name: 'Hash input' })).toHaveValue('typed earlier');

    await attach('a', 'hash', 'input', textFile('notes.txt'));
    await waitFor(() => {
      expect(within(panel).queryByRole('textbox', { name: 'Hash input' })).not.toBeInTheDocument();
    });
    expect(within(panel).getByText('notes.txt')).toBeInTheDocument();

    /*
     * AND IT SAYS SO. A file takes the box away, which is right - but it leaves
     * somebody who typed a paragraph and then chose a file with no way to know
     * their paragraph survived, and nothing to suggest that removing the file
     * is how to get it back.
     */
    expect(within(panel).getByText(/The text you typed is kept/)).toBeInTheDocument();

    await user.click(within(panel).getByRole('button', { name: 'Remove notes.txt' }));
    await waitFor(() => {
      expect(within(panel).getByRole('textbox', { name: 'Hash input' })).toHaveValue(
        'typed earlier',
      );
    });
  });

  /*
   * And it is NOT said on a port nobody typed into, which is the condition that
   * makes it worth one line in a 320px rail rather than noise on every port.
   */
  it('says nothing about kept text when there was none', async () => {
    const user = userEvent.setup();
    seed([node('a', 'hash')]);
    renderCanvas();
    await attach('a', 'hash', 'input', textFile('notes.txt'));
    select('a');

    const panel = await openInspector(user);
    expect(within(panel).queryByText(/you typed is kept/)).not.toBeInTheDocument();
  });

  it('unblocks the node, so a bytes-only tool can finally run on the canvas', async () => {
    seed([node('a', 'image-convert')]);
    renderCanvas();

    await waitFor(() => {
      expect(summaryOf('a')).toContain('Add a file in the inspector');
    });

    await attach('a', 'image-convert', 'input', pngFile());
    await waitFor(() => {
      expect(screen.getByTestId('node-a')).not.toHaveTextContent(/blocked/);
    });
  });

  /*
   * The node names the file while it has no answer yet - which is what tells
   * one image node from another on a canvas of ten - and the name stays in the
   * accessible name once the answer arrives and takes the box.
   */
  it('names the file on the node, and in its accessible name', async () => {
    seed([node('a', 'image-convert')]);
    renderCanvas();
    await attach('a', 'image-convert', 'input', pngFile('holiday.png', 2000));

    await waitFor(() => {
      expect(screen.getByTestId('node-a')).toHaveAccessibleName(/from holiday\.png · 2\.0 kB/);
    });
  });
});

/* ========================================================================== *
 * Size and type, refused where the user is standing
 * ========================================================================== */

describe('a file the port cannot use is refused at selection', () => {
  it('refuses an oversized file by name, size and limit', async () => {
    const user = userEvent.setup();
    seed([node('a', 'color-convert')]);
    renderCanvas();
    select('a');

    const panel = await openInspector(user);
    // color-convert's limit is 4 kB: it takes a colour, not a document.
    await user.upload(
      within(panel).getByLabelText('Choose file'),
      new File(['x'.repeat(8192)], 'huge.txt', { type: 'text/plain' }),
    );

    expect(await screen.findByText(/over this tool's 4\.0 kB limit/)).toBeInTheDocument();
    expect(useCanvasStore.getState().graph.nodes.a?.fileInputs.input).toBeUndefined();
  });

  it('refuses a binary file on a text-only port, naming what it looked like', async () => {
    const user = userEvent.setup();
    seed([node('a', 'jwt-decode')]);
    renderCanvas();
    select('a');

    const panel = await openInspector(user);
    await user.upload(within(panel).getByLabelText('Choose file'), pngFile('token.txt'));

    expect(
      await screen.findByText(/looks like png image, and Token needs text/),
    ).toBeInTheDocument();
    expect(useCanvasStore.getState().graph.nodes.a?.fileInputs.input).toBeUndefined();
  });
});

/* ========================================================================== *
 * Reload
 * ========================================================================== */

describe('a canvas reloaded with a file on a port', () => {
  /*
   * THE PERSISTENCE ANSWER, AND WHY IT IS THIS ONE.
   *
   * A `File` cannot be JSON-serialised into the `localStorage` key the graph
   * lives in, and putting one in IndexedDB would mean a canvas silently
   * carrying somebody's 60 MB photograph across sessions. So the bytes are
   * session state - and the document keeps the smallest true statement it can
   * make about them, which is what lets the node say something specific rather
   * than come back looking as though nobody had ever fed it.
   */
  it('saves the name and size and never the bytes', async () => {
    seed([node('a', 'image-convert')]);
    renderCanvas();
    await attach('a', 'image-convert', 'input', pngFile('holiday.png', 100));

    const persisted = toPersisted(useCanvasStore.getState().graph);
    const serialised = JSON.stringify(persisted);

    expect(persisted.nodes[0]?.fileInputs.input).toMatchObject({
      name: 'holiday.png',
      size: 108,
    });
    // Nothing that could be the file itself. A PNG header base64-encoded, and
    // the raw bytes, are both absent because only three scalars are written.
    expect(serialised).not.toContain('iVBOR');
    expect(Object.keys(persisted.nodes[0]?.fileInputs.input ?? {}).sort()).toEqual([
      'name',
      'size',
      'token',
    ]);
  });

  /*
   * The reload itself: the document remembers, the session does not, and the
   * node says which file to go and find. Simulated by keeping the graph and
   * clearing the attachments, which is exactly the difference a page load makes.
   */
  it('blocks the node and names the file to choose again', async () => {
    seed([node('a', 'image-convert', 0, 0, { fileInputs: { input: reference('holiday.png') } })]);
    renderCanvas();

    await waitFor(() => {
      expect(summaryOf('a')).toBe('"holiday.png" needs choosing again');
    });
  });

  it('explains itself in the inspector, with the file named', async () => {
    const user = userEvent.setup();
    seed([node('a', 'image-convert', 0, 0, { fileInputs: { input: reference('holiday.png') } })]);
    renderCanvas();
    select('a');

    const panel = await openInspector(user);
    expect(within(panel).getByText(/holiday\.png · 1\.0 kB/)).toBeInTheDocument();
    expect(
      within(panel).getByText(/A file is never saved with a canvas, so choose it again/),
    ).toBeInTheDocument();
    expect(within(panel).getByLabelText('Choose file')).toBeInTheDocument();
  });

  /*
   * NOT "Add a file in the inspector". A node that was fed a photograph and
   * comes back being told to type into it reads as the canvas having lost
   * something silently, which is the failure mode this whole answer exists to
   * avoid.
   */
  it('does not tell the user to type into a port they fed a file', async () => {
    seed([node('a', 'hash', 0, 0, { fileInputs: { input: reference('notes.txt') } })]);
    renderCanvas();

    await waitFor(() => {
      expect(summaryOf('a')).toBe('"notes.txt" needs choosing again');
    });
    expect(summaryOf('a')).not.toContain('Type');
  });

  /*
   * AND IT SAYS THE NAME ONCE. The accessible name carries the file so that a
   * chain is followable by ear once a result takes the summary box - but a
   * reloaded node's summary already NAMES the file, and appending `from
   * notes.txt · 1.0 kB` to `"notes.txt" needs choosing again` read it twice in
   * one breath.
   */
  it('names the file once in the accessible name, not twice', async () => {
    seed([node('a', 'hash', 0, 0, { fileInputs: { input: reference('notes.txt') } })]);
    renderCanvas();

    await waitFor(() => {
      expect(summaryOf('a')).toContain('needs choosing again');
    });

    const label = screen.getByTestId('node-a').getAttribute('aria-label') ?? '';
    expect(label).toContain('"notes.txt" needs choosing again');
    expect(label.match(/notes\.txt/g)).toHaveLength(1);
  });

  it('lets the reference be forgotten, which returns the port to normal', async () => {
    const user = userEvent.setup();
    seed([node('a', 'hash', 0, 0, { fileInputs: { input: reference('notes.txt') } })]);
    renderCanvas();
    select('a');

    const panel = await openInspector(user);
    await user.click(within(panel).getByRole('button', { name: 'Forget notes.txt' }));

    await waitFor(() => {
      expect(useCanvasStore.getState().graph.nodes.a?.fileInputs.input).toBeUndefined();
    });
    expect(summaryOf('a')).not.toContain('needs choosing again');
  });
});

/* ========================================================================== *
 * A save from outside this session
 * ========================================================================== */

describe('a file reference naming a port that does not exist', () => {
  /*
   * `fileInputs` is keyed by port id and comes back from `localStorage`, which
   * is neither signed nor beyond a user's reach - so a hand-edited save can
   * name a port no tool has. The ENGINE ignores such a key, correctly, because
   * it iterates the manifest's ports rather than the document's keys.
   *
   * What the node did was print it anyway: `phantom.png · 1.0 kB` under a
   * result the file had nothing to do with, on a node that was running
   * perfectly well. A statement on a node has to be derived from the ports the
   * tool actually has, the same way every other read of that record is.
   */
  it('is not printed on the node', async () => {
    seed([
      node('a', 'hash', 0, 0, {
        inputs: { input: 'typed' },
        fileInputs: { nosuchport: reference('phantom.png') },
      }),
    ]);
    renderCanvas();

    await waitFor(() => {
      expect(screen.getByTestId('node-a')).not.toHaveTextContent(/blocked/);
    });
    expect(summaryOf('a')).not.toContain('phantom.png');
    expect(screen.getByTestId('node-a').getAttribute('aria-label')).not.toContain('phantom.png');
  });

  /*
   * And it does not block the node either: the port it names does not exist, so
   * there is nothing waiting on it. `input` is satisfied by the typed text and
   * the node runs, which is the behaviour the engine already had.
   */
  it('does not block the node it is attached to', async () => {
    seed([
      node('a', 'hash', 0, 0, {
        inputs: { input: 'typed' },
        fileInputs: { nosuchport: reference('phantom.png') },
      }),
    ]);
    renderCanvas();

    /*
     * The FOOTER's status word, not the node's whole text content. A node
     * renders its status, its ports and its summary as adjacent inline spans,
     * so `textContent` reads `Hash8msabcInputDigestok0 wires` - in which "ok"
     * has no word boundary on either side, and a `\bok\b` match is a test that
     * can only ever fail.
     */
    await waitFor(() => {
      expect(statusOf('a')).toBe('ok');
    });
  });
});

/* ========================================================================== *
 * Share links
 * ========================================================================== */

describe('a shared pipeline', () => {
  /*
   * THE SHARE-LINK ANSWER. The bytes could not travel at any size, so the only
   * question was the NAME - and a filename is often the most revealing single
   * string in a document: `Q3-layoffs.xlsx` says something a pipeline's shape
   * does not. The recipient does not have the file and would gain nothing but
   * the name, so they get told what the port needs by the port itself, exactly
   * as they are for a text input nobody typed into.
   */
  it('carries no filename, so a link cannot leak what the sender opened', async () => {
    seed([node('a', 'image-convert')]);
    renderCanvas();
    await attach('a', 'image-convert', 'input', pngFile('Q3-layoffs.png'));

    const payload = toSharePayload(useCanvasStore.getState().graph);
    expect(JSON.stringify(payload)).not.toContain('Q3-layoffs');
    expect(JSON.stringify(payload)).not.toContain('fileInputs');
  });

  /*
   * A graph REPLACED rather than edited drops every file with it. Node ids
   * repeat across documents - every canvas starts at `n1` - so an attachment
   * that survived would hand the previous canvas's file to whatever the new one
   * happens to call `n1`, which is one person's data appearing inside a
   * pipeline somebody else shared with them.
   */
  it('drops every file when the graph is replaced', async () => {
    seed([node('n1', 'hash')]);
    renderCanvas();
    await attach('n1', 'hash', 'input', textFile('mine.txt'));
    expect(useAttachmentStore.getState().valueFor('n1', 'input')).toBeDefined();

    act(() => {
      useCanvasStore.getState().replaceGraph({
        ...EMPTY_GRAPH,
        nodes: { n1: node('n1', 'image-convert') },
        nodeOrder: ['n1'],
        nextId: 2,
      });
    });

    expect(useAttachmentStore.getState().valueFor('n1', 'input')).toBeUndefined();
  });
});

/* ========================================================================== *
 * Fan-out and the cache
 * ========================================================================== */

describe('one file feeding more than one node', () => {
  /*
   * BINARY PAYLOAD OWNERSHIP HAS BITTEN BEFORE. Buffers are borrowed by default
   * and transferred only on an explicit opt-in, because a fan-out to two
   * consumers detaches the second - `fanout.test.ts` holds that line for a
   * wired output, and this holds it for a file, which is a second source of
   * one buffer reaching several tools.
   */
  it('gives both nodes intact bytes rather than detaching the second', async () => {
    const seen: BinaryData[] = [];
    usePipelineStore.setState({
      execute: (options) => {
        const value = options.inputs.input;
        if (value?.type === 'bytes') seen.push(value.data);
        return Promise.resolve<ToolResult<ToolOutputs>>({
          ok: true,
          value: { output: { type: 'text', text: 'digest' } },
        });
      },
    });

    seed([node('a', 'hash'), node('b', 'hash', 400, 0)]);
    renderCanvas();

    const loaded = await loadedFor('hash', 'input', textFile('shared.txt', 'hi'));
    act(() => {
      const store = useAttachmentStore.getState();
      const first = store.attach('a', 'input', loaded);
      const second = store.attach('b', 'input', loaded);
      useCanvasStore.getState().setNodeFile('a', 'input', first);
      useCanvasStore.getState().setNodeFile('b', 'input', second);
    });

    await waitFor(() => {
      expect(seen.length).toBeGreaterThanOrEqual(2);
    });

    /*
     * READ EVERY ONE OF THEM, one after another, which is the assertion that
     * matters now. Detaching was the old hazard and a blob cannot be detached;
     * the new one would be a value that reads back correctly ONCE - and
     * reading all of them is how that would show.
     */
    for (const data of seen) {
      expect(Array.from(await materialiseBinary(data))).toEqual([104, 105]);
    }
  });

  it('copies the file onto a duplicated node rather than leaving it claiming one', async () => {
    seed([node('n1', 'image-convert')]);
    renderCanvas();
    await attach('n1', 'image-convert', 'input', pngFile());

    act(() => {
      useCanvasStore.getState().select({ nodes: ['n1'], edges: [] });
      useCanvasStore.getState().duplicateSelection();
    });

    const copyId = useCanvasStore.getState().selection.nodes[0];
    expect(copyId).toBeDefined();
    if (copyId === undefined) return;
    expect(useCanvasStore.getState().graph.nodes[copyId]?.fileInputs.input).toBeDefined();
    // And the bytes, not merely the reference - otherwise the copy would look
    // exactly like a reloaded node and ask to be fed again.
    expect(useAttachmentStore.getState().valueFor(copyId, 'input')).toBeDefined();
  });
});

describe('the cache and a replaced file', () => {
  /*
   * A node's cache key is built from its typed input and its FILE reference,
   * and the reference carries a token for exactly this case: two different
   * files can share a name and a size, and serving the first one's answer for
   * the second is the worst failure this cache can have - nobody reports it,
   * because nothing looks wrong.
   */
  it('re-runs when a file is swapped for a different one of the same name and size', async () => {
    const digests: BinaryData[] = [];
    usePipelineStore.setState({
      execute: (options) => {
        const value = options.inputs.input;
        if (value?.type === 'bytes') digests.push(value.data);
        return Promise.resolve<ToolResult<ToolOutputs>>({
          ok: true,
          value: { output: { type: 'text', text: 'digest' } },
        });
      },
    });

    seed([node('a', 'hash')]);
    renderCanvas();

    const read = async (): Promise<number[][]> =>
      Promise.all(digests.map(async (data) => Array.from(await materialiseBinary(data))));

    await attach('a', 'hash', 'input', new File(['aa'], 'same.txt'));
    await waitFor(async () => {
      expect(await read()).toContainEqual([97, 97]);
    });

    await attach('a', 'hash', 'input', new File(['bb'], 'same.txt'));
    await waitFor(async () => {
      expect(await read()).toContainEqual([98, 98]);
    });
  });
});

/* ========================================================================== *
 * Dropping a file
 * ========================================================================== */

describe('dropping a file on the canvas', () => {
  /*
   * THE WORST THING THIS ROUTE USED TO DO, and it did it with no code at all:
   * with no handler anywhere, dropping a file on the canvas made the BROWSER
   * navigate to it, replacing the app with a picture. `preventDefault` on
   * `dragover` across the whole workspace is what stops that, and it is
   * asserted first because it is true whatever the drop then means.
   */
  it('never lets the browser navigate to the dropped file', () => {
    seed([node('a', 'hash')]);
    renderCanvas();

    const event = dragOver(screen.getByTestId('canvas-workspace'));
    expect(event.defaultPrevented).toBe(true);
  });

  it('puts the file on the only port that can take it', async () => {
    seed([node('a', 'image-convert')]);
    renderCanvas();

    dropOn(screen.getByTestId('node-a'), pngFile('dropped.png'));

    await waitFor(() => {
      expect(useCanvasStore.getState().graph.nodes.a?.fileInputs.input).toMatchObject({
        name: 'dropped.png',
      });
    });
    expect(useAttachmentStore.getState().valueFor('a', 'input')).toBeDefined();
  });

  /*
   * TWO PORTS AND NO WAY TO GUESS. `diff` is the only tool in the set with two
   * inputs, and neither of them is "the" one - so the gesture hands over to the
   * inspector, which has two named controls, instead of picking the first port
   * and making one of the two comparisons unreachable by drag.
   */
  it('opens the inspector instead of guessing when a node has two inputs', async () => {
    seed([node('a', 'diff')]);
    renderCanvas();

    dropOn(screen.getByTestId('node-a'), textFile('left.txt'));

    await waitFor(() => {
      expect(screen.getByTestId('node-inspector')).toBeInTheDocument();
    });
    expect(useCanvasStore.getState().selection.nodes).toEqual(['a']);
    expect(useCanvasStore.getState().graph.nodes.a?.fileInputs).toEqual({});
    expect(await screen.findByText(/Choose a file for Original and Changed/)).toBeInTheDocument();
  });

  /*
   * A DROP ON THE BACKGROUND IS REFUSED, not turned into a node. Deciding which
   * tool a file wants means picking on the user's behalf from its bytes, and a
   * gesture that silently chooses a tool is a worse surprise than one that does
   * nothing and says what would have worked.
   */
  it('says what would have worked when dropped on the background', async () => {
    seed([node('a', 'hash')]);
    renderCanvas();

    dropOn(screen.getByTestId('canvas-root'), pngFile());

    expect(
      await screen.findByText('Drop a file onto a node, or choose one in the inspector.'),
    ).toBeInTheDocument();
  });

  it('refuses a drop on a node whose every input is wired', async () => {
    seed(
      [node('a', 'base64'), node('b', 'hash', 400, 0)],
      [{ id: 'e1', from: { nodeId: 'a', portId: 'output' }, to: { nodeId: 'b', portId: 'input' } }],
    );
    renderCanvas();

    dropOn(screen.getByTestId('node-b'), textFile('notes.txt'));

    expect(await screen.findByText(/Every input on Hash is wired/)).toBeInTheDocument();
  });

  it('refuses an oversized drop with the same message the chooser gives', async () => {
    seed([node('a', 'color-convert')]);
    renderCanvas();

    dropOn(
      screen.getByTestId('node-a'),
      new File(['x'.repeat(8192)], 'huge.txt', { type: 'text/plain' }),
    );

    expect(await screen.findByText(/over this tool's 4\.0 kB limit/)).toBeInTheDocument();
  });
});

/* ========================================================================== *
 * Keyboard
 * ========================================================================== */

describe('the keyboard route into a file input', () => {
  /*
   * A DROP ZONE WITH NO KEYBOARD EQUIVALENT IS NOT ACCEPTABLE, and the reason
   * there is no separate keyboard path to maintain is that the real
   * `<input type="file">` IS the control - visually hidden, focusable, and
   * labelled by the button beside it.
   */
  it('is a focusable, labelled file input rather than a drop zone', async () => {
    const user = userEvent.setup();
    seed([node('a', 'image-convert')]);
    renderCanvas();
    select('a');

    const panel = await openInspector(user);
    const chooser = within(panel).getByLabelText('Choose file');
    expect(chooser.tagName).toBe('INPUT');
    expect(chooser).toHaveAttribute('type', 'file');
    expect(chooser).not.toBeDisabled();

    chooser.focus();
    expect(chooser).toHaveFocus();
  });

  /*
   * `Enter` on a node means "step into that node's input". For a bytes-only
   * port there is no editor to step into, and its file chooser is what the key
   * has to mean instead - otherwise the key silently does nothing on exactly
   * the node the whole change exists for.
   */
  it('is what Enter lands on for a node with no text editor', async () => {
    const user = userEvent.setup();
    seed([node('a', 'image-convert')]);
    renderCanvas();

    screen.getByTestId('node-a').focus();
    await user.keyboard('{Enter}');

    const panel = screen.getByTestId('node-inspector');
    expect(within(panel).getByLabelText('Choose file')).toHaveFocus();
  });

  /*
   * And on a node that HAS an editor, Enter still lands in the editor rather
   * than on the file control - the fix that stopped it landing on "Close the
   * inspector" must not be traded for landing on the chooser.
   */
  it('does not steal Enter from a node that has a text editor', async () => {
    const user = userEvent.setup();
    seed([node('a', 'hash')]);
    renderCanvas();

    screen.getByTestId('node-a').focus();
    await user.keyboard('{Enter}');

    const panel = screen.getByTestId('node-inspector');
    expect(within(panel).getByRole('textbox', { name: 'Hash input' })).toHaveFocus();
  });
});

/** A document reference with no attachment behind it: what a reload leaves. */
function reference(name: string, size = 1024) {
  return { name, size, token: 1 };
}
