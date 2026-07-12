import { promises as fs } from "node:fs";
import path from "node:path";

// Reports used to always land on local disk (generated-reports/), which
// breaks the moment you run more than one backend process or redeploy
// without a persistent volume. This module is the single seam: local disk
// stays the zero-config default for dev/single-instance, and REPORT_STORAGE_DRIVER=s3
// switches every write/read to an S3-compatible bucket without touching
// reportEngine.ts or the download route.

const REPORTS_DIR = path.resolve(process.cwd(), "generated-reports");
const driver = (process.env.REPORT_STORAGE_DRIVER ?? "local").toLowerCase();

async function ensureLocalDir() {
  await fs.mkdir(REPORTS_DIR, { recursive: true });
}

interface S3Client {
  put(key: string, body: string): Promise<void>;
  get(key: string): Promise<Buffer>;
}

let s3Client: S3Client | null = null;

/** Lazily constructs the S3 client so @aws-sdk/client-s3 is only touched when actually configured. */
async function getS3Client(): Promise<S3Client> {
  if (s3Client) return s3Client;

  const bucket = process.env.REPORT_S3_BUCKET;
  const region = process.env.REPORT_S3_REGION;
  if (!bucket || !region) {
    throw new Error("REPORT_STORAGE_DRIVER=s3 requires REPORT_S3_BUCKET and REPORT_S3_REGION");
  }

  const { S3Client, PutObjectCommand, GetObjectCommand } = await import("@aws-sdk/client-s3");
  const client = new S3Client({
    region,
    endpoint: process.env.REPORT_S3_ENDPOINT || undefined,
    credentials:
      process.env.REPORT_S3_ACCESS_KEY_ID && process.env.REPORT_S3_SECRET_ACCESS_KEY
        ? {
            accessKeyId: process.env.REPORT_S3_ACCESS_KEY_ID,
            secretAccessKey: process.env.REPORT_S3_SECRET_ACCESS_KEY,
          }
        : undefined,
  });

  s3Client = {
    async put(key, body) {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: "text/csv" }));
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

/** Writes a generated report's CSV body under `${reportId}.csv` and returns nothing — read it back with readReport(). */
export async function writeReport(reportId: string, csv: string): Promise<void> {
  if (driver === "s3") {
    const client = await getS3Client();
    await client.put(`${reportId}.csv`, csv);
    return;
  }
  await ensureLocalDir();
  await fs.writeFile(path.join(REPORTS_DIR, `${reportId}.csv`), csv, "utf-8");
}

/** Reads a previously written report's CSV body back as a Buffer. */
export async function readReport(reportId: string): Promise<Buffer> {
  if (driver === "s3") {
    const client = await getS3Client();
    return client.get(`${reportId}.csv`);
  }
  return fs.readFile(path.join(REPORTS_DIR, `${reportId}.csv`));
}

export function reportStorageDriver() {
  return driver;
}
