// Thin Notion REST client: upload a preview image and create the journal row.

import type { Capture } from "./capture";

const NOTION_VERSION = "2022-06-28";

export interface NotionConfig {
  token: string;
  databaseId: string;
  /** Overridable for local testing against a mock server. */
  apiBase?: string;
}

export interface JournalEntry {
  title: string;
  kind: "Photo" | "Video";
  capture: Capture;
  filename: string;
  sizeBytes: number;
  sha256: string;
  phoneSha256Matched: boolean;
  originalUrl: string;
  storageKey: string;
  tags: string[];
  caption?: string;
  preview?: { bytes: Uint8Array; contentType: string; filename: string };
}

export async function createJournalPage(cfg: NotionConfig, entry: JournalEntry): Promise<{ id: string; url: string }> {
  const previewId = entry.preview ? await uploadFile(cfg, entry.preview) : undefined;
  const { capture } = entry;

  const properties: Record<string, unknown> = {
    Name: { title: [text(entry.title)] },
    Taken: { date: { start: capture.taken.start, ...(capture.taken.timeZone ? { time_zone: capture.taken.timeZone } : {}) } },
    Type: { select: { name: entry.kind } },
    Original: { url: entry.originalUrl },
    "SHA-256": { rich_text: [text(entry.sha256)] },
    "Size (MB)": { number: Math.round((entry.sizeBytes / 1_048_576) * 100) / 100 },
    Filename: { rich_text: [text(entry.filename)] },
  };
  if (capture.place) properties.Place = { rich_text: [text(capture.place)] };
  if (capture.latitude !== undefined && capture.longitude !== undefined) {
    properties.Latitude = { number: capture.latitude };
    properties.Longitude = { number: capture.longitude };
    properties.Map = { url: `https://maps.google.com/?q=${capture.latitude},${capture.longitude}` };
  }
  if (capture.camera) properties.Camera = { rich_text: [text(capture.camera)] };
  if (capture.durationSeconds !== undefined) properties["Duration (s)"] = { number: capture.durationSeconds };
  if (entry.tags.length) properties.Tags = { multi_select: entry.tags.map((name) => ({ name })) };
  if (previewId) {
    properties.Preview = { files: [{ type: "file_upload", file_upload: { id: previewId }, name: entry.preview!.filename }] };
  }

  const children: unknown[] = [];
  if (previewId) children.push({ type: "image", image: { type: "file_upload", file_upload: { id: previewId } } });
  if (entry.caption) children.push(paragraph([text(entry.caption)]));
  children.push(
    paragraph([text("Original file: "), link(`${entry.filename} (${entry.kind.toLowerCase()})`, entry.originalUrl)]),
    { type: "heading_3", heading_3: { rich_text: [text("Provenance")] } },
    bullet(`SHA-256 of original: ${entry.sha256}`),
    bullet(
      entry.phoneSha256Matched
        ? "Fingerprint computed on the iPhone before upload matched the fingerprint computed on arrival."
        : "Fingerprint computed on arrival (the iPhone did not send one).",
    ),
    bullet(`Capture time source: ${capture.taken.source}`),
    bullet(`Location source: ${capture.locationSource ?? "none"}`),
    bullet(`Archived unmodified in Cloudflare R2 as ${entry.storageKey}`),
  );

  const res = await notion(cfg, "/v1/pages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ parent: { database_id: cfg.databaseId }, properties, children }),
  });
  const page = (await res.json()) as { id: string; url: string };
  return { id: page.id, url: page.url };
}

async function uploadFile(cfg: NotionConfig, file: NonNullable<JournalEntry["preview"]>): Promise<string> {
  const created = await notion(cfg, "/v1/file_uploads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ filename: file.filename, content_type: file.contentType }),
  });
  const { id } = (await created.json()) as { id: string };
  const form = new FormData();
  form.append("file", new Blob([file.bytes], { type: file.contentType }), file.filename);
  await notion(cfg, `/v1/file_uploads/${id}/send`, { method: "POST", body: form });
  return id;
}

async function notion(cfg: NotionConfig, path: string, init: RequestInit): Promise<Response> {
  const res = await fetch((cfg.apiBase ?? "https://api.notion.com") + path, {
    ...init,
    headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${cfg.token}`, "notion-version": NOTION_VERSION },
  });
  if (!res.ok) throw new Error(`Notion ${path} failed: ${res.status} ${await res.text()}`);
  return res;
}

const text = (content: string) => ({ type: "text", text: { content: content.slice(0, 2000) } });
const link = (content: string, url: string) => ({ type: "text", text: { content, link: { url } } });
const paragraph = (rich_text: unknown[]) => ({ type: "paragraph", paragraph: { rich_text } });
const bullet = (s: string) => ({ type: "bulleted_list_item", bulleted_list_item: { rich_text: [text(s)] } });
