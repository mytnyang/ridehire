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
  /** Why this item is in the journal (AI reason or Legacy album). */
  selection: string;
  preview?: { bytes: Uint8Array; contentType: string; filename: string };
}

export async function createJournalPage(cfg: NotionConfig, entry: JournalEntry): Promise<{ id: string; url: string }> {
  const previewId = entry.preview ? await uploadFile(cfg, entry.preview) : undefined;
  const { capture } = entry;

  // Legacy's Life Journal has Name, Date, Tags and Entry. Entry is left for you;
  // everything else about the file goes in the page body.
  const properties: Record<string, unknown> = {
    Name: { title: [text(entry.title)] },
    Date: { date: { start: capture.taken.start, ...(capture.taken.timeZone ? { time_zone: capture.taken.timeZone } : {}) } },
    Tags: { multi_select: [entry.kind, ...entry.tags].map((name) => ({ name })) },
  };

  const details: string[] = [];
  if (capture.place) details.push(`Place: ${capture.place}`);
  if (capture.camera) details.push(`Camera: ${capture.camera}`);
  if (capture.durationSeconds !== undefined) details.push(`Length: ${capture.durationSeconds} s`);
  details.push(`File: ${entry.filename} (${(entry.sizeBytes / 1_048_576).toFixed(2)} MB)`);

  const children: unknown[] = [];
  // Videos get a player that streams the archived original (the Worker serves byte ranges).
  const player = entry.kind === "Video" ? { type: "video", video: { type: "external", external: { url: entry.originalUrl } } } : undefined;
  if (player) children.push(player);
  if (previewId) children.push({ type: "image", image: { type: "file_upload", file_upload: { id: previewId } } });
  children.push(paragraph([text("Original file: "), link(`${entry.filename} (${entry.kind.toLowerCase()})`, entry.originalUrl)]));
  for (const d of details) children.push(bullet(d));
  if (capture.latitude !== undefined && capture.longitude !== undefined) {
    const mapUrl = `https://maps.google.com/?q=${capture.latitude},${capture.longitude}`;
    children.push({ type: "bulleted_list_item", bulleted_list_item: { rich_text: [text("Location: "), link(`${capture.latitude}, ${capture.longitude}`, mapUrl)] } });
  }
  children.push(
    { type: "heading_3", heading_3: { rich_text: [text("Provenance")] } },
    bullet(`SHA-256 of original: ${entry.sha256}`),
    bullet(
      entry.phoneSha256Matched
        ? "Fingerprint computed on the iPhone before upload matched the fingerprint computed on arrival."
        : "Fingerprint computed on arrival (the iPhone did not send one).",
    ),
    bullet(entry.selection),
    bullet(`Capture time source: ${capture.taken.source}`),
    bullet(`Location source: ${capture.locationSource ?? "none"}`),
    bullet(`Archived unmodified in Cloudflare R2 as ${entry.storageKey}`),
  );

  const create = (blocks: unknown[]) =>
    notion(cfg, "/v1/pages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parent: { database_id: cfg.databaseId }, properties, children: blocks }),
    });
  let res: Response;
  try {
    res = await create(children);
  } catch (err) {
    // If Notion won't accept the embedded player, still log the entry; the "Original file" link plays it too.
    if (!player || !(err instanceof NotionError) || err.status !== 400) throw err;
    res = await create(children.filter((c) => c !== player));
  }
  const page = (await res.json()) as { id: string; url: string };
  return { id: page.id, url: page.url };
}

/** Creates a page in the journal database with the given properties and no body. */
export async function createPage(cfg: NotionConfig, properties: Record<string, unknown>): Promise<string> {
  const res = await notion(cfg, "/v1/pages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ parent: { database_id: cfg.databaseId }, properties }),
  });
  return ((await res.json()) as { id: string }).id;
}

/** Appends blocks to a page and returns the new blocks' ids, in order. */
export async function appendBlocks(cfg: NotionConfig, pageId: string, blocks: unknown[]): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < blocks.length; i += 100) {
    const res = await notion(cfg, `/v1/blocks/${pageId}/children`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ children: blocks.slice(i, i + 100) }),
    });
    ids.push(...((await res.json()) as { results: { id: string }[] }).results.map((r) => r.id));
  }
  return ids;
}

export async function deleteBlock(cfg: NotionConfig, blockId: string): Promise<void> {
  try {
    await notion(cfg, `/v1/blocks/${blockId}`, { method: "DELETE" });
  } catch (err) {
    if (!(err instanceof NotionError) || err.status !== 404) throw err; // already gone
  }
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
  if (!res.ok) throw new NotionError(res.status, `Notion ${path} failed: ${res.status} ${await res.text()}`);
  return res;
}

class NotionError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const text = (content: string) => ({ type: "text", text: { content: content.slice(0, 2000) } });
export const link = (content: string, url: string) => ({ type: "text", text: { content, link: { url } } });
const paragraph = (rich_text: unknown[]) => ({ type: "paragraph", paragraph: { rich_text } });
export const bullet = (s: string) => ({ type: "bulleted_list_item", bulleted_list_item: { rich_text: [text(s)] } });
