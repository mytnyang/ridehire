// Glasses Journal: receives photos/videos from an iPhone Shortcut, archives the
// untouched original in R2, fingerprints it, and logs it as a row in Notion.
//
//   POST /v1/screen                       (multipart: sha256, preview, inLegacyAlbum) -> { include, reason, alreadyLogged? }
//   POST /v1/uploads                      -> { file, uploadUrl, completeUrl }
//   PUT  <uploadUrl>                       (the raw file; direct to R2 when R2 keys are set)
//   POST /v1/uploads/:file/complete        (multipart: sha256, takenAt, latitude, longitude, place, preview)
//   GET  /m/:file?sig=...                  (signed link to the original, written into Notion)

import { AwsClient } from "aws4fetch";
import { formatTaken, resolveCapture, type PhoneMetadata } from "./capture";
import { parseJpegExif } from "./exif";
import { readMp4Info } from "./mp4";
import { createJournalPage } from "./notion";
import { screenPhoto, type ScreenResult } from "./screen";

export interface Env {
  MEDIA: R2Bucket;
  UPLOAD_TOKEN: string;
  LINK_SECRET: string;
  NOTION_TOKEN: string;
  NOTION_DATABASE_ID: string;
  NOTION_API_BASE?: string;
  TIMEZONE: string;
  DEFAULT_TAGS?: string;
  R2_BUCKET_NAME?: string;
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_BASE_URL?: string;
  AI_MODEL?: string;
}

const CONTENT_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  heic: "image/heic",
  png: "image/png",
  mp4: "video/mp4",
  mov: "video/quicktime",
};
const VIDEO_EXTS = new Set(["mp4", "mov"]);
const FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|heic|png|mp4|mov)$/;
const EXIF_SCAN_BYTES = 256 * 1024;
const MAX_INLINE_PREVIEW_BYTES = 4 * 1024 * 1024;
const MAX_SCREEN_IMAGE_BYTES = 3_500_000;
const SHA256_RE = /^[0-9a-f]{64}$/;
const UPLOAD_URL_TTL_SECONDS = 3600;

/** Cached screening decision, keyed by the original's SHA-256. */
interface ScreenDecision extends ScreenResult {
  source: "ai" | "legacy-album";
  decidedAt: string;
}

interface HashMarker {
  key: string;
  notionPageId: string;
  notionUrl: string;
  loggedAt: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (request.method === "GET" && path === "/health") return json({ ok: true });

      const media = /^\/m\/([^/]+)$/.exec(path);
      if (media && (request.method === "GET" || request.method === "HEAD")) return serveOriginal(request, env, media[1], url);

      // Upload URLs carry their own expiring signature (like R2's presigned URLs),
      // so the Shortcut PUTs to them without headers in either mode.
      const body = /^\/v1\/uploads\/([^/]+)\/body$/.exec(path);
      if (body && request.method === "PUT") return receiveBody(request, env, body[1], url);

      if (!(await authorized(request, env))) return json({ error: "unauthorized" }, 401);

      if (request.method === "POST" && path === "/v1/screen") return screen(request, env);
      if (request.method === "POST" && path === "/v1/uploads") return startUpload(request, env, url);

      const complete = /^\/v1\/uploads\/([^/]+)\/complete$/.exec(path);
      if (complete && request.method === "POST") return completeUpload(request, env, complete[1], url);

      return json({ error: "not found" }, 404);
    } catch (err) {
      console.error(err);
      return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

// Decides, before anything is uploaded, whether an item belongs in Legacy's
// Life Journal. Items that don't are never uploaded, logged or deleted.
async function screen(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const sha256 = String(form.get("sha256") ?? "").trim().toLowerCase();
  if (!SHA256_RE.test(sha256)) return json({ error: "sha256 (hex) is required" }, 400);

  // Already archived and logged: no need to upload again. The phone's fingerprint
  // matches the archived original, so its copy is safe to delete.
  const marker = await env.MEDIA.get(`by-hash/${sha256}.json`);
  if (marker) {
    const { key, notionUrl } = (await marker.json()) as HashMarker;
    if (await env.MEDIA.head(key)) return json({ include: true, alreadyLogged: true, notionUrl, safeToDelete: true, reason: "Already logged" });
  }

  let decision: ScreenDecision;
  // The Legacy album always wins, including over an earlier "no" from the AI.
  if (String(form.get("inLegacyAlbum") ?? "").toLowerCase() === "true") {
    decision = { include: true, reason: "In the Legacy album", source: "legacy-album", decidedAt: new Date().toISOString() };
  } else {
    const cached = await env.MEDIA.get(decisionKey(sha256));
    if (cached) return json({ ...((await cached.json()) as ScreenDecision), cached: true });
    if (!env.ANTHROPIC_API_KEY) return json({ error: "ANTHROPIC_API_KEY is not set" }, 503);
    const preview = form.get("preview");
    if (!preview || typeof preview === "string" || preview.size === 0) {
      return json({ include: false, reason: "No preview image sent; not decided", retry: true });
    }
    const bytes = new Uint8Array(await preview.arrayBuffer());
    if (bytes.length > MAX_SCREEN_IMAGE_BYTES) return json({ include: false, reason: "Preview too large; resize it smaller", retry: true });
    const result = await screenPhoto({ apiKey: env.ANTHROPIC_API_KEY, model: env.AI_MODEL || "claude-opus-5", baseURL: env.ANTHROPIC_BASE_URL }, bytes);
    // Not cached, so the item is simply left alone and asked about again next run.
    if (!result) return json({ include: false, reason: "AI could not decide right now; will retry", retry: true });
    decision = { ...result, source: "ai", decidedAt: new Date().toISOString() };
  }
  await env.MEDIA.put(decisionKey(sha256), JSON.stringify(decision), { httpMetadata: { contentType: "application/json" } });
  return json(decision);
}

async function startUpload(request: Request, env: Env, url: URL): Promise<Response> {
  const { filename } = (await request.json().catch(() => ({}))) as { filename?: string };
  const ext = extensionOf(filename ?? "");
  if (!ext) return json({ error: `unsupported file type: ${filename ?? "(no filename)"}` }, 400);
  const file = `${crypto.randomUUID()}.${ext}`;
  const key = storageKey(file);

  const expires = Math.floor(Date.now() / 1000) + UPLOAD_URL_TTL_SECONDS;
  let uploadUrl = `${url.origin}/v1/uploads/${file}/body?expires=${expires}&sig=${await sign(env, `put:${file}:${expires}`)}`;
  let direct = false;
  if (env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY) {
    // Presigned PUT straight to R2 — avoids the Worker's 100 MB request limit for long videos.
    const aws = new AwsClient({ accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY, service: "s3", region: "auto" });
    const target = new URL(`https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME ?? "glasses-journal"}/${key}`);
    target.searchParams.set("X-Amz-Expires", String(UPLOAD_URL_TTL_SECONDS));
    uploadUrl = (await aws.sign(new Request(target, { method: "PUT" }), { aws: { signQuery: true } })).url;
    direct = true;
  }
  return json({ file, uploadUrl, direct, completeUrl: `${url.origin}/v1/uploads/${file}/complete` });
}

async function receiveBody(request: Request, env: Env, file: string, url: URL): Promise<Response> {
  if (!FILE_RE.test(file)) return json({ error: "bad file id" }, 400);
  const expires = url.searchParams.get("expires") ?? "";
  const sig = url.searchParams.get("sig") ?? "";
  if (!(await safeEqual(sig, await sign(env, `put:${file}:${expires}`)))) return json({ error: "bad upload signature" }, 403);
  if (!(Number(expires) > Date.now() / 1000)) return json({ error: "upload URL expired" }, 403);
  if (await env.MEDIA.head(storageKey(file))) return json({ error: "already uploaded" }, 409);
  if (!request.body) return json({ error: "empty body" }, 400);
  await env.MEDIA.put(storageKey(file), request.body, { httpMetadata: { contentType: contentTypeOf(file) } });
  return json({ ok: true });
}

async function completeUpload(request: Request, env: Env, file: string, url: URL): Promise<Response> {
  if (!FILE_RE.test(file)) return json({ error: "bad file id" }, 400);
  const key = storageKey(file);
  const head = await env.MEDIA.head(key);
  if (!head) return json({ error: "file not uploaded yet" }, 404);

  const form = request.headers.get("content-type")?.includes("form") ? await request.formData() : new FormData();
  const field = (name: string) => {
    const v = form.get(name);
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
  };

  // Fingerprint exactly what is stored.
  const sha256 = await hashObject(env, key);
  const phoneSha = field("sha256")?.toLowerCase();
  if (phoneSha && phoneSha !== sha256) {
    await env.MEDIA.delete(key);
    return json({ error: "fingerprint mismatch: the file changed in transit; upload it again", expected: phoneSha, received: sha256 }, 422);
  }

  // The phone may delete its copy only when it sent a fingerprint and that
  // fingerprint matches an original we hold and have logged in Notion.
  const phoneVerified = phoneSha === sha256;

  const markerKey = `by-hash/${sha256}.json`;
  const existing = await env.MEDIA.get(markerKey);
  if (existing) {
    const marker = (await existing.json()) as HashMarker;
    // Only treat it as a duplicate if the archived original is still there.
    if (marker.key === key || (await env.MEDIA.head(marker.key))) {
      if (marker.key !== key) await env.MEDIA.delete(key); // same content already archived under another name
      return json({ status: "duplicate", sha256, notionUrl: marker.notionUrl, safeToDelete: phoneVerified });
    }
  }

  // Only items that passed screening (or are in the Legacy album) may be logged.
  const decisionObj = await env.MEDIA.get(decisionKey(sha256));
  const decision = decisionObj ? ((await decisionObj.json()) as ScreenDecision) : undefined;
  if (!decision?.include) {
    await env.MEDIA.delete(key);
    return json({ error: "not approved for Legacy's Life Journal; call /v1/screen first", safeToDelete: false }, 409);
  }

  const ext = file.split(".").pop()!;
  const isVideo = VIDEO_EXTS.has(ext);
  const filename = field("filename") ?? file;

  const exif = !isVideo && (ext === "jpg" || ext === "jpeg") ? parseJpegExif(await readRange(env, key, 0, EXIF_SCAN_BYTES)) : null;
  const mp4 = isVideo ? await readMp4Info((o, l) => readRange(env, key, o, l), head.size).catch(() => null) : null;
  const phone: PhoneMetadata = {
    takenAt: field("takenAt"),
    latitude: numberOrUndefined(field("latitude")),
    longitude: numberOrUndefined(field("longitude")),
    place: field("place"),
  };
  const capture = resolveCapture({ exif, mp4, phone, timeZone: env.TIMEZONE, now: new Date() });

  let preview: { bytes: Uint8Array; contentType: string; filename: string } | undefined;
  const previewField = form.get("preview");
  if (previewField && typeof previewField !== "string" && previewField.size > 0) {
    preview = { bytes: new Uint8Array(await previewField.arrayBuffer()), contentType: "image/jpeg", filename: "preview.jpg" };
  } else if (!isVideo && (ext === "jpg" || ext === "jpeg") && head.size <= MAX_INLINE_PREVIEW_BYTES) {
    preview = { bytes: await readRange(env, key, 0, head.size), contentType: "image/jpeg", filename };
  }

  const kind = isVideo ? "Video" : "Photo";
  const page = await createJournalPage(
    { token: env.NOTION_TOKEN, databaseId: env.NOTION_DATABASE_ID, apiBase: env.NOTION_API_BASE },
    {
      title: decision.title ?? `${kind} · ${formatTaken(capture.taken, env.TIMEZONE)}`,
      kind,
      capture,
      filename,
      sizeBytes: head.size,
      sha256,
      phoneSha256Matched: phoneVerified,
      originalUrl: `${url.origin}/m/${file}?sig=${await sign(env, file)}`,
      storageKey: key,
      tags: (env.DEFAULT_TAGS ?? "").split(",").map((t) => t.trim()).filter(Boolean),
      selection: decision.source === "legacy-album" ? "Added from the Legacy album." : `Picked by AI: ${decision.reason}`,
      preview,
    },
  );

  const marker: HashMarker = { key, notionPageId: page.id, notionUrl: page.url, loggedAt: new Date().toISOString() };
  await env.MEDIA.put(markerKey, JSON.stringify(marker), { httpMetadata: { contentType: "application/json" } });
  return json({ status: "logged", sha256, notionUrl: page.url, safeToDelete: phoneVerified });
}

async function serveOriginal(request: Request, env: Env, file: string, url: URL): Promise<Response> {
  if (!FILE_RE.test(file)) return new Response("not found", { status: 404 });
  const sig = url.searchParams.get("sig") ?? "";
  if (!(await safeEqual(sig, await sign(env, file)))) return new Response("forbidden", { status: 403 });

  const obj = await env.MEDIA.get(storageKey(file), { range: request.headers });
  if (!obj) return new Response("not found", { status: 404 });
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  if (!headers.has("content-type")) headers.set("content-type", contentTypeOf(file));
  headers.set("accept-ranges", "bytes");
  headers.set("etag", obj.httpEtag);
  headers.set("cache-control", "private, max-age=3600");
  let status = 200;
  const range = obj.range as { offset?: number; length?: number } | undefined;
  if (request.headers.has("range") && range && range.offset !== undefined) {
    const length = range.length ?? obj.size - range.offset;
    headers.set("content-range", `bytes ${range.offset}-${range.offset + length - 1}/${obj.size}`);
    headers.set("content-length", String(length));
    status = 206;
  } else {
    headers.set("content-length", String(obj.size));
  }
  return new Response(request.method === "HEAD" ? null : obj.body, { status, headers });
}

async function hashObject(env: Env, key: string): Promise<string> {
  const obj = await env.MEDIA.get(key);
  if (!obj) throw new Error(`missing object ${key}`);
  const digest = new crypto.DigestStream("SHA-256");
  await obj.body.pipeTo(digest);
  return hex(await digest.digest);
}

async function readRange(env: Env, key: string, offset: number, length: number): Promise<Uint8Array> {
  const obj = await env.MEDIA.get(key, { range: { offset, length } });
  if (!obj) throw new Error(`missing object ${key}`);
  return new Uint8Array(await obj.arrayBuffer());
}

async function authorized(request: Request, env: Env): Promise<boolean> {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  return !!env.UPLOAD_TOKEN && (await safeEqual(token, env.UPLOAD_TOKEN));
}

async function sign(env: Env, file: string): Promise<string> {
  if (!env.LINK_SECRET) throw new Error("LINK_SECRET is not set");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.LINK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(file))).slice(0, 32);
}

async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

const storageKey = (file: string) => `originals/${file}`;
const decisionKey = (sha256: string) => `decisions/${sha256}.json`;
const contentTypeOf = (file: string) => CONTENT_TYPES[file.split(".").pop()!] ?? "application/octet-stream";

function extensionOf(filename: string): string | undefined {
  const ext = filename.split(".").pop()?.toLowerCase();
  return ext && ext !== filename.toLowerCase() && ext in CONTENT_TYPES ? ext : undefined;
}

function numberOrUndefined(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const n = Number(s.replace(",", "."));
  return Number.isFinite(n) ? n : undefined;
}

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
