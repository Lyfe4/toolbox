import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { CloseIcon, InfoIcon } from '@/components/Icon';
import { IconButton } from '@/components/IconButton';
import { cx } from '@/lib/cx';
import { formatBytes, sniffBytes, type SniffResult } from '@/lib/sniff';

import styles from './runner.module.css';

export interface LoadedFile {
  readonly file: File;
  readonly sniff: SniffResult;
}

export interface FileDropProps {
  readonly onFile: (loaded: LoadedFile | null) => void;
  readonly loaded: LoadedFile | null;
  readonly maxBytes: number;
  readonly onReject: (message: string) => void;
  readonly disabled?: boolean;
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
 */
export function FileDrop({ onFile, loaded, maxBytes, onReject, disabled = false }: FileDropProps) {
  const inputId = useId();
  const describedById = useId();
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const zoneRef = useRef<HTMLDivElement>(null);

  const accept = useCallback(
    async (file: File): Promise<void> => {
      // Size is checked BEFORE reading, so an enormous file is refused rather
      // than pulled into memory and freezing the tab.
      if (file.size > maxBytes) {
        onReject(
          `"${file.name}" is ${formatBytes(file.size)}, over this tool's ${formatBytes(maxBytes)} limit.`,
        );
        return;
      }

      const bytes = new Uint8Array(await file.arrayBuffer());
      // The file's declared type is ignored; the bytes decide.
      onFile({ file, sniff: sniffBytes(bytes) });
    },
    [maxBytes, onFile, onReject],
  );

  useEffect(() => {
    const zone = zoneRef.current;
    if (!zone) return;

    const onDragOver = (event: DragEvent): void => {
      // Without preventDefault the browser navigates to the dropped file.
      event.preventDefault();
      if (!disabled) setDragging(true);
    };
    const onDragLeave = (): void => {
      setDragging(false);
    };
    const onDrop = (event: DragEvent): void => {
      event.preventDefault();
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

  return (
    <div ref={zoneRef} className={cx(styles.dropZone, dragging && styles.dropZoneActive)}>
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        className={styles.fileInput}
        aria-describedby={describedById}
        disabled={disabled}
        onChange={(event) => {
          const file = event.target.files?.item(0);
          if (file) void accept(file);
        }}
      />
      <label className={styles.fileButton} htmlFor={inputId}>
        Choose file
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
            onClick={() => {
              onFile(null);
              if (inputRef.current) inputRef.current.value = '';
            }}
          />
        </p>
      ) : null}
    </div>
  );
}
