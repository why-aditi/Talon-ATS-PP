/**
 * Object storage behind an interface, the way `IdentityProvider` sits in front of
 * Cognito (CLAUDE.md §2). Feature code writes against `FileStore`; only the adapter
 * below knows S3 exists, so the dry-run and commit paths can be tested without a
 * bucket or LocalStack.
 *
 * Uploads land in a QUARANTINE prefix and are read from there. An uploaded CSV is
 * attacker-controlled by definition — it is the whole premise of an import feature —
 * which puts it under §4.17 / ARCHITECTURE §9.10 alongside resumes: separate prefix,
 * scanned before it is trusted, never served back from the app origin.
 */
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/** Presigned URLs are short-lived: the client uploads immediately or starts again. */
export const UPLOAD_TTL_SECONDS = 900;
export const DOWNLOAD_TTL_SECONDS = 300;

export interface FileStore {
  /** A URL the browser PUTs to directly. The API never sees the bytes. */
  presignUpload(key: string, byteSize: number): Promise<{ url: string; expiresIn: number }>;
  /** A URL the browser GETs. Always `attachment`, never inline (§4.17). */
  presignDownload(key: string, filename: string): Promise<{ url: string; expiresIn: number }>;
  read(key: string): Promise<Uint8Array>;
  write(key: string, body: string, contentType: string): Promise<void>;
}

export class S3FileStore implements FileStore {
  constructor(
    private readonly s3: S3Client,
    private readonly bucket: string,
  ) {}

  async presignUpload(key: string, byteSize: number): Promise<{ url: string; expiresIn: number }> {
    const url = await getSignedUrl(
      this.s3,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        // Bound the upload at the signature. We never see the request, so this is the
        // only place a size limit can be enforced — an unbounded presigned PUT is an
        // open door to filling the bucket.
        ContentLength: byteSize,
        ContentType: 'text/csv',
      }),
      { expiresIn: UPLOAD_TTL_SECONDS },
    );
    return { url, expiresIn: UPLOAD_TTL_SECONDS };
  }

  async presignDownload(key: string, filename: string): Promise<{ url: string; expiresIn: number }> {
    const url = await getSignedUrl(
      this.s3,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        // The error CSV is built from attacker-supplied rows. Forcing a download rather
        // than letting a browser render it is the same rule resumes follow (§4.17), and
        // the reason it is signed from the file host rather than the app origin.
        ResponseContentDisposition: `attachment; filename="${filename.replaceAll('"', '')}"`,
        ResponseContentType: 'text/csv',
      }),
      { expiresIn: DOWNLOAD_TTL_SECONDS },
    );
    return { url, expiresIn: DOWNLOAD_TTL_SECONDS };
  }

  async read(key: string): Promise<Uint8Array> {
    const out = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!out.Body) throw new Error(`empty object at ${key}`);
    return new Uint8Array(await out.Body.transformToByteArray());
  }

  async write(key: string, body: string, contentType: string): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }
}

/**
 * Keys are derived, never supplied. A client-chosen key is a path-traversal and an
 * overwrite primitive at once; the tenant prefix additionally means a misconfigured
 * bucket policy fails per-tenant rather than globally.
 */
export const uploadKey = (tenantId: string, importId: string) =>
  `quarantine/${tenantId}/${importId}/source.csv`;

export const errorCsvKey = (tenantId: string, importId: string) =>
  `reports/${tenantId}/${importId}/errors.csv`;

/**
 * Used when no bucket is configured — tests, and a local `pnpm dev` without AWS.
 *
 * Deliberately in-process and deliberately lossy: it exists so the import paths can be
 * exercised end to end without a bucket, NOT as a storage tier. The container picks it
 * only when `TALON_UPLOADS_BUCKET` is unset, so a deployed environment that forgets to
 * configure one gets uploads that vanish on restart rather than silent success — loud
 * in the way a missing bucket should be.
 */
export class InMemoryFileStore implements FileStore {
  readonly #objects = new Map<string, string>();

  presignUpload(key: string, _byteSize: number): Promise<{ url: string; expiresIn: number }> {
    return Promise.resolve({ url: `memory://${key}`, expiresIn: UPLOAD_TTL_SECONDS });
  }

  presignDownload(key: string, _filename: string): Promise<{ url: string; expiresIn: number }> {
    return Promise.resolve({ url: `memory://${key}`, expiresIn: DOWNLOAD_TTL_SECONDS });
  }

  read(key: string): Promise<Uint8Array> {
    const body = this.#objects.get(key);
    if (body === undefined) return Promise.reject(new Error(`no object at ${key}`));
    return Promise.resolve(new TextEncoder().encode(body));
  }

  write(key: string, body: string): Promise<void> {
    this.#objects.set(key, body);
    return Promise.resolve();
  }

  /** Test seam: puts a file where `read` will find it, without a presigned PUT. */
  seed(key: string, body: string): void {
    this.#objects.set(key, body);
  }
}
