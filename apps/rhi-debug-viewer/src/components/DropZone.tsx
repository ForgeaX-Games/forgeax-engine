// DropZone.tsx — file drop area + hidden file input for tape pair loading.
//
// Dual input path (D-6):
//   1. Drag-and-drop: user drops .tape.bin + report.json files onto the zone.
//   2. Hidden file input: click-to-browse fallback. Accepts .tape.bin + .json files;
//      the <input> has multiple attribute so setInputFiles works from e2e smoke.
//
// Calls `onFiles` callback with the selected File objects. Parent (App.tsx)
// delegates to tape-source.ts for pair matching, deserialization, and
// buildViewModel.

import { useCallback, useRef, useState } from 'react';

export interface DropZoneProps {
  readonly onFiles: (files: File[]) => void;
  readonly disabled?: boolean;
}

export function DropZone({ onFiles, disabled = false }: DropZoneProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDragOver = useCallback(
    (e: React.DragEvent<HTMLButtonElement>) => {
      e.preventDefault();
      if (!disabled) setIsDragOver(true);
    },
    [disabled],
  );

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLButtonElement>) => {
    e.preventDefault();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLButtonElement>) => {
      e.preventDefault();
      setIsDragOver(false);
      if (disabled) return;

      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) {
        onFiles(files);
      }
    },
    [disabled, onFiles],
  );

  const handleFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      if (files.length > 0) {
        onFiles(files);
      }
      // Reset input so re-selecting the same files triggers onChange again
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    },
    [onFiles],
  );

  const handleClick = useCallback(() => {
    if (!disabled && fileInputRef.current) {
      fileInputRef.current.click();
    }
  }, [disabled]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleClick();
      }
    },
    [handleClick],
  );

  return (
    <button
      type="button"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      disabled={disabled}
      className={`
        w-full border-2 border-dashed rounded-lg p-12 text-center cursor-pointer
        transition-colors duration-200 bg-inherit
        ${
          isDragOver
            ? 'border-blue-500 bg-blue-50 dark:bg-blue-950'
            : 'border-slate-300 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-600'
        }
        ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
      `}
    >
      <p className="text-slate-600 dark:text-slate-400">
        Drop{' '}
        <code className="text-sm bg-slate-100 dark:bg-slate-800 px-1 rounded">
          frame-N.tape.bin
        </code>
        {' + '}
        <code className="text-sm bg-slate-100 dark:bg-slate-800 px-1 rounded">
          frame-N.report.json
        </code>{' '}
        files here
      </p>
      <p className="text-sm text-slate-400 dark:text-slate-500 mt-2">or click to browse</p>
      <input
        ref={fileInputRef}
        type="file"
        accept=".tape.bin,.json"
        multiple
        onChange={handleFileInputChange}
        className="hidden"
        aria-label="Select tape files"
      />
    </button>
  );
}
