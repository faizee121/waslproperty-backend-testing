import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../config/env.js';

let client: S3Client | undefined;

function getClient(): S3Client {
  if (!client) {
    client = new S3Client({ region: env.AWS_REGION });
  }
  return client;
}

/** A short-lived URL the frontend PUTs the file bytes to directly — the
 * backend never proxies file bytes. */
export async function presignPut(
  key: string,
  contentType: string,
  expiresInSeconds = 300,
): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: env.S3_BUCKET_NAME,
    Key: key,
    ContentType: contentType,
  });
  return getSignedUrl(getClient(), command, { expiresIn: expiresInSeconds });
}

/** A short-lived URL the frontend reads the file bytes from directly. */
export async function presignGet(key: string, expiresInSeconds = 300): Promise<string> {
  const command = new GetObjectCommand({ Bucket: env.S3_BUCKET_NAME, Key: key });
  return getSignedUrl(getClient(), command, { expiresIn: expiresInSeconds });
}

/** Downloads an object's bytes directly into the backend process — unlike
 * presignPut/presignGet (which exist specifically so the backend never
 * proxies file bytes for the frontend), the M15 document-analysis
 * pipeline genuinely needs the real bytes server-side to render/OCR them.
 * Used nowhere else — every other upload/download in this codebase stays
 * on the presigned-URL pattern above. */
export async function getObjectBytes(key: string): Promise<Buffer> {
  const command = new GetObjectCommand({ Bucket: env.S3_BUCKET_NAME, Key: key });
  const response = await getClient().send(command);
  const body = response.Body;
  if (!body) throw new Error(`S3 object ${key} has no body`);
  const chunks: Uint8Array[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
