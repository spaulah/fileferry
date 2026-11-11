import { type GraphHttp } from './http.js';
import { type DriveRef } from './graph.js';
import { encodeGraphPath } from './paths.js';
import { type RetryPolicy, withRetry } from './retry.js';

// Graph requires chunk sizes to be multiples of 320 KiB.
export const CHUNK_ALIGNMENT_BYTES: number = 320 * 1024;
export const DEFAULT_SIMPLE_UPLOAD_MAX_BYTES: number = 4 * 1024 * 1024;
export const DEFAULT_UPLOAD_CHUNK_BYTES: number = CHUNK_ALIGNMENT_BYTES * 10; // 3.2 MiB

export interface UploadSettings {
  simpleUploadMaxBytes: number;
  chunkBytes: number;
  retry: RetryPolicy;
}

/**
 * Uploads one file, overwriting any existing file at `targetPath`. Small files use a
 * single PUT. Larger ones use a resumable upload session, which is safe to retry
 * because each chunk is an absolute byte range.
 */
export const uploadFile = async (
  http: GraphHttp,
  drive: DriveRef,
  targetPath: string,
  file: Blob,
  settings: UploadSettings
): Promise<void> => {
  const itemPath = `/sites/${drive.siteId}/drives/${drive.driveId}/root:/${encodeGraphPath(targetPath)}`;

  if (file.size <= settings.simpleUploadMaxBytes) {
    await withRetry(
      () => http.authorized('PUT', `${itemPath}:/content`, file, { 'Content-Type': 'application/octet-stream' }),
      settings.retry
    );
    return;
  }

  const session = await withRetry(
    () =>
      http.json<{ uploadUrl: string }>('POST', `${itemPath}:/createUploadSession`, {
        item: { '@microsoft.graph.conflictBehavior': 'replace' }
      }),
    settings.retry
  );

  let start = 0;
  while (start < file.size) {
    start = await uploadChunkWithResume(http, session.uploadUrl, file, start, settings);
  }
};

// Returns the next byte to send. After a transient failure the session is asked where
// to resume, because the chunk may have been received even though the reply was lost.
const uploadChunkWithResume = async (
  http: GraphHttp,
  uploadUrl: string,
  file: Blob,
  start: number,
  settings: UploadSettings
): Promise<number> => {
  let chunkStart: number = start;

  return withRetry(
    () => uploadChunk(http, uploadUrl, file, chunkStart, settings.chunkBytes),
    settings.retry,
    {
      beforeRetry: async () => {
        chunkStart = await nextExpectedByte(http, uploadUrl, start);
      }
    }
  );
};

const uploadChunk = async (
  http: GraphHttp,
  uploadUrl: string,
  file: Blob,
  start: number,
  chunkBytes: number
): Promise<number> => {
  const end: number = Math.min(start + chunkBytes, file.size) - 1;

  await http.preauthorized(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Range': `bytes ${start}-${end}/${file.size}` },
    body: file.slice(start, end + 1)
  });

  return end + 1;
};

const nextExpectedByte = async (http: GraphHttp, uploadUrl: string, fallback: number): Promise<number> => {
  const response: Response = await http.preauthorized(uploadUrl);
  const status = (await response.json()) as { nextExpectedRanges?: string[] };
  const nextRange: string | undefined = status.nextExpectedRanges?.[0];
  if (!nextRange) {
    return fallback;
  }
  const resumeFrom: number = Number.parseInt(nextRange.split('-')[0] ?? '', 10);
  return Number.isNaN(resumeFrom) ? fallback : resumeFrom;
};
