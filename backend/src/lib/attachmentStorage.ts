import { promises as fs } from "node:fs";
import path from "node:path";

// Same seam as reportStorage.ts, but binary-safe (attachments aren't CSV
// text) and keyed by an opaque storageKey rather than a report id, since one
// email can have many attachments. Local disk is the zero-config default;
// ATTACHMENT_STORAGE_DRIVER=s3 switches every write/read to an S3-compatible
// bucket without touching imapSync.ts, emailSync.ts, or the download route.
// Deliberately does NOT share reportStorage's S3 client — different bucket/
// content-type semantics (binary vs text/csv) — but the shape is identical
// on purpose so the two are easy to reconcile into one module later if
// that duplication starts to hurt.

const ATTACHMENTS_DIR = path.resolve(process.cwd(), "generated-attachments");
const driver = (process.env.ATTACHMENT_STORAGE_DRIVER ?? "local").toLowerCase();

async function ensureLocalDir() {
  await fs.mkdir(ATTACHMENTS_DIR, { recursive: true });
}

function safeLocalPath(storageKey: string): string {
  // storageKey is server-generated (see makeStorageKey below), but guard
  // against path traversal regardless of caller.
  const normalized = path.normalize(storageKey).replace(/^(\.\.[/\\])+/, "");
  return path.join(ATTACHMENTS_DIR, normalized);
}

interface S3Client {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
}

let s3Client: S3Client | null = null;

/** Lazily constructs the S3 client so @aws-sdk/client-s3 is only touched when actually configured. */
async function getS3Client(): Promise<S3Client> {
  if (s3Client) return s3Client;

  const bucket = process.env.ATTACHMENT_S3_BUCKET;
  const region = process.env.ATTACHMENT_S3_REGION;
  if (!bucket || !region) {
    throw new Error("ATTACHMENT_STORAGE_DRIVER=s3 requires ATTACHMENT_S3_BUCKET and ATTACHMENT_S3_REGION");
  }

  const { S3Client, PutObjectCommand, GetObjectCommand } = await import("@aws-sdk/client-s3");
  const client = new S3Client({
    region,
    endpoint: process.env.ATTACHMENT_S3_ENDPOINT || undefined,
    credentials:
      process.env.ATTACHMENT_S3_ACCESS_KEY_ID && process.env.ATTACHMENT_S3_SECRET_ACCESS_KEY
        ? {
            accessKeyId: process.env.ATTACHMENT_S3_ACCESS_KEY_ID,
            secretAccessKey: process.env.ATTACHMENT_S3_SECRET_ACCESS_KEY,
          }
        : undefined,
  });

  s3Client = {
    async put(key, body, contentType) {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
    },
    async get(key) {
      const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const chunks: Buffer[] = [];
      // @ts-expect-error - Body is a Node.js Readable in the Node runtime
      for await (const chunk of result.Body) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks);
    },
  };
  return s3Client;
}

/** Builds a collision-resistant storage key for one attachment on one email. Exported so callers/tests can predict it. */
export function makeStorageKey(emailId: string, attachmentIndex: number, filename: string): string {
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-100) || "attachment";
  return `${emailId}/${attachmentIndex}-${safeName}`;
}

/** Writes an attachment's raw bytes under storageKey. */
export async function writeAttachment(storageKey: string, data: Buffer, mimeType: string): Promise<void> {
  if (driver === "s3") {
    const client = await getS3Client();
    await client.put(storageKey, data, mimeType);
    return;
  }
  await ensureLocalDir();
  const dest = safeLocalPath(storageKey);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, data);
}

/** Reads a previously written attachment's bytes back as a Buffer. */
export async function readAttachment(storageKey: string): Promise<Buffer> {
  if (driver === "s3") {
    const client = await getS3Client();
    return client.get(storageKey);
  }
  return fs.readFile(safeLocalPath(storageKey));
}

export function attachmentStorageDriver() {
  return driver;
}
