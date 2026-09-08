import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { CloseIcon, InfoIcon } from '@/components/Icon';
import { IconButton } from '@/components/IconButton';
import type { InputPort } from '@/features/registry/types';
import { cx } from '@/lib/cx';
import { describeFile, loadFileForPort, type LoadedFile, type SizeBudget } from '@/lib/fileInput';
import { formatBytes } from '@/lib/sniff';

import styles from './runner.module.css';

export type { LoadedFile };

/** A file the document remembers but this session no longer has the bytes of. */
export interface PendingFile {
  readonly name: string;
  readonly size: number;
}

export interface FileDropProps {
  /**
   * The port this control feeds.
   *
   * Passed rather than inferred so the control refuses a file the port cannot
   * use AT THE MOMENT OF SELECTION, naming what it looked like - see
   * `loadFileForPort`. It is also what makes one component correct for a tool
   * with two document ports, where "the file" is not a well-formed idea.
   */
  readonly port: InputPort;
  readonly onFile: (loaded: LoadedFile | null) => void;
  readonly loaded: LoadedFile | null;
  /**
   * A file this canvas was saved with, whose bytes are gone.
   *
   * A graph persists the NAME of a chosen file and never its contents, so a
   * reloaded node knows it was fed `photo.png` and cannot produce it. Saying so
   * is the whole reason this prop exists: the alternative is a node that looks
   * as though nobody ever fed it. Ignored while `loaded` is set.
   */
  readonly pending?: PendingFile | null;
  readonly maxBytes: number;
  /**
   * What this node's other inputs already contribute towards `maxBytes`.
   *
   * `maxInputBytes` bounds a tool's whole input rather than one file, so on a
   * two-port tool the second file has to be weighed against the first. Zero
   * where there is nothing else to weigh.
   */
  readonly otherBytes?: number;
  readonly onReject: (message: string) => void;
  readonly disabled?: boolean;
  /**
   * The chooser's accessible name. Defaults to "Choose file", which is right
   * where there is one; a tool with two document ports needs two names that
   * tell them apart.
   */
  readonly label?: string;
}

/**
 * File input with a drag-and-drop convenience layer.
 *
 * The keyboard path is not bolted on beside the drop zone: the real
 * `<input type="file">` IS the control. It is visually hidden but focusable and
 * labelled, so Tab then Enter opens the picker. Dragging is extra.
 *
 * The drag handlers are attached imperatively rather than as JSX props. A
 * `<div>` carrying interaction props is a genuine accessibility smell - it is
 * usually someone building a button out of a div - and silencing that warning
 * would blunt a rule worth keeping. A drop target is not a control, so it
 * should not look like one to the linter either.
 *
 * NOTHING ABOUT THIS COMPONENT IS ROUTE-SPECIFIC. The canvas inspector renders
 * one per unwired input port and the tool runner renders one per tool; the only
 * difference between them is which port they are handed.
 */
export function FileDrop({
  port,
  onFile,
  loaded,
  pending = null,
  maxBytes,
  otherBytes = 0,
  onReject,
  disabled = false,
  label = 'Choose file',
}: FileDropProps) {
  const inputId = useId();
  const describedById = useId();
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const zoneRef = useRef<HTMLDivElement>(null);

  const accept = useCallback(
    async (file: File): Promise<void> => {
      const budget: SizeBudget = { maxBytes, otherBytes };
      const result = await loadFileForPort(port, file, budget);
      if ('error' in result) {
        onReject(result.error);
        return;
      }
      onFile(result.loaded);
    },
    [maxBytes, onFile, onReject, otherBytes, port],
  );

  useEffect(() => {
    const zone = zoneRef.current;
    if (!zone) return;

    const onDragOver = (event: DragEvent): void => {
      // Without preventDefault the browser navigates to the dropped file.
      event.preventDefault();
      if (!disabled) setDragging(true);
    };
    const onDragLeave = (event: DragEvent): void => {
      /*
       * ONLY WHEN THE POINTER HAS REALLY LEFT THE ZONE.
       *
       * `dragleave` fires for every child boundary crossed on the way across,
       * and this zone has four children - so dragging a file from its edge
       * towards the button flickered the active border off and on again under
       * the cursor. Worse in the inspector than on a tool page, where the
       * label is most of a 320px rail.
       *
       * A `relatedTarget` inside the zone means the pointer moved to a child
       * rather than out; `null` is the genuine exit, and also what a drag
       * leaving the window gives.
       */
      const next = event.relatedTarget;
      if (next instanceof Node && zone.contains(next)) return;
      setDragging(false);
    };
    const onDrop = (event: DragEvent): void => {
      event.preventDefault();
      /*
       * The drop is handled HERE and must not also be handled by the canvas
       * behind it, which drops onto whichever node is under the pointer. A
       * drop inside this zone has already named its port.
       */
      event.stopPropagation();
      setDragging(false);
      if (disabled) return;
      const file = event.dataTransfer?.files.item(0);
      if (file) void accept(file);
    };

    zone.addEventListener('dragover', onDragOver);
    zone.addEventListener('dragleave', onDragLeave);
    zone.addEventListener('drop', onDrop);

    return () => {
      zone.removeEventListener('dragover', onDragOver);
      zone.removeEventListener('dragleave', onDragLeave);
      zone.removeEventListener('drop', onDrop);
    };
  }, [accept, disabled]);

  const clear = (): void => {
    onFile(null);
    // Cleared so choosing the SAME file again fires a change event. Without
    // this, removing a file and re-picking it silently does nothing.
    if (inputRef.current) inputRef.current.value = '';
  };

  return (
    <div ref={zoneRef} className={cx(styles.dropZone, dragging && styles.dropZoneActive)}>
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        className={styles.fileInput}
        aria-describedby={describedById}
        disabled={disabled}
        /*
         * The hook `Enter` on a canvas node looks for. A port that cannot take
         * text has no editor to step into, and its file chooser is what
         * "step into this node's input" means there.
         */
        data-file-input={port.id}
        onChange={(event) => {
          const file = event.target.files?.item(0);
          if (file) void accept(file);
        }}
      />
      <label className={styles.fileButton} htmlFor={inputId}>
        {label}
      </label>

      <p className={styles.hint} id={describedById}>
        Or drop a file here. Up to {formatBytes(maxBytes)}. Nothing is uploaded.
      </p>

      {loaded ? (
        <p className={styles.fileSummary}>
          <InfoIcon size={12} />
          <span className={styles.mono}>{loaded.file.name}</span>
          <span className={styles.fileBadge}>{loaded.sniff.label}</span>
          <span>{formatBytes(loaded.file.size)}</span>
          <IconButton
            label={`Remove ${loaded.file.name}`}
            size="sm"
            icon={<CloseIcon size={12} />}
            onClick={clear}
          />
        </p>
      ) : pending ? (
        /*
         * A FILE THE DOCUMENT REMEMBERS AND THE SESSION DOES NOT HAVE.
         *
         * Stated as prose rather than drawn as a summary with a Remove button,
         * because it is not a chosen file: nothing is loaded, the node is
         * blocked, and the only useful action is choosing it again. The name is
         * repeated so the user knows WHICH file to look for.
         */
        <p className={styles.fileSummary}>
          <InfoIcon size={12} />
          <span>
            <span className={styles.mono}>{describeFile(pending.name, pending.size)}</span> was used
            here. A file is never saved with a canvas, so choose it again.
          </span>
          <IconButton
            label={`Forget ${pending.name}`}
            size="sm"
            icon={<CloseIcon size={12} />}
            onClick={clear}
          />
        </p>
      ) : null}
    </div>
  );
}
