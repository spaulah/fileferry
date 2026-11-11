import { useRef, useState, type DragEvent } from 'react';
import {
  collectFromEntries,
  collectFromFileList,
  type FileSelection
} from '@fileferry/core';

interface DropZoneProps {
  selection: FileSelection;
  onSelect: (incoming: FileSelection) => void;
  onClear: () => void;
}

// Drag-and-drop folders and files, or pick them. Folder structure is kept, and empty
// folders are recorded too.
export function DropZone({ selection, onSelect, onClear }: DropZoneProps) {
  const [dragging, setDragging] = useState<boolean>(false);
  const [message, setMessage] = useState<string | null>(null);
  const folderInput = useRef<HTMLInputElement | null>(null);

  const handleDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);

    // The DataTransfer is cleared when the handler returns, so entries are read synchronously.
    const entries = Array.from(event.dataTransfer.items)
      .map((item) => item.webkitGetAsEntry())
      .filter((entry): entry is FileSystemEntry => entry !== null);

    const incoming = await collectFromEntries(entries);
    onSelect(incoming);
    setMessage(describeAdded(incoming));
  };

  return (
    <div className="dropzone-wrap">
      <div
        className={`dropzone ${dragging ? 'dragging' : ''}`}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => { setDragging(false); }}
        onDrop={handleDrop}
      >
        <p>Drop files or folders here</p>
        <div className="row small">
          <label className="link">
            Pick files
            <input
              type="file"
              multiple
              hidden
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                const incoming = collectFromFileList(files);
                onSelect(incoming);
                setMessage(describeAdded(incoming));
                event.target.value = '';
              }}
            />
          </label>
          <label className="link">
            Pick a folder
            <input
              ref={(element) => {
                folderInput.current = element;
                // React does not type webkitdirectory, so it is set on the element directly.
                element?.setAttribute('webkitdirectory', '');
              }}
              type="file"
              hidden
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                const incoming = collectFromFileList(files);
                onSelect(incoming);
                setMessage(describeAdded(incoming));
                event.target.value = '';
              }}
            />
          </label>
          {(selection.files.length > 0 || selection.folders.length > 0) && (
            <button type="button" className="ghost small-btn" onClick={onClear}>
              Clear
            </button>
          )}
        </div>
      </div>

      {message && <p className="hint">{message}</p>}
      {selection.files.length > 0 && (
        <ul className="files">
          {selection.files.map((item) => (
            <li key={item.relativePath}>{item.relativePath}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

const describeAdded = (incoming: FileSelection): string =>
  `Added ${incoming.files.length} file(s) and ${incoming.folders.length} folder(s).`;
