// One "Legacy's day" page per calendar day in the journal, listing that day's
// logged moments in time order, each linking to its entry. State lives in R2
// (days/YYYY-MM-DD.json) so the list can be rebuilt in order as items arrive
// out of order (e.g. a backlog run).

import { appendBlocks, createPage, deleteBlock, text, type NotionConfig } from "./notion";

export interface TimelineItem {
  /** "HH:MM:SS" local time, for ordering. */
  sortKey: string;
  /** "3:04 PM" */
  time: string;
  kind: "Photo" | "Video";
  /** The item's journal entry. */
  pageId: string;
}

interface DayState {
  pageId: string;
  blockIds: string[];
  items: TimelineItem[];
}

export async function addToDayTimeline(cfg: NotionConfig, bucket: R2Bucket, day: string, item: TimelineItem, tags: string[]): Promise<void> {
  const key = `days/${day}.json`;
  const stored = await bucket.get(key);
  const state: DayState = stored
    ? ((await stored.json()) as DayState)
    : {
        pageId: await createPage(cfg, {
          Name: { title: [text(`Legacy's day · ${displayDay(day)}`)] },
          Date: { date: { start: day } },
          Tags: { multi_select: ["Timeline", ...tags].map((name) => ({ name })) },
        }),
        blockIds: [],
        items: [],
      };

  if (state.items.some((i) => i.pageId === item.pageId)) return;
  state.items.push(item);
  state.items.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  const save = () => bucket.put(key, JSON.stringify(state), { httpMetadata: { contentType: "application/json" } });
  await save(); // keep the item even if the rebuild below fails; the next one redraws everything

  for (const id of state.blockIds) await deleteBlock(cfg, id);
  const n = state.items.length;
  state.blockIds = await appendBlocks(cfg, state.pageId, [
    { type: "paragraph", paragraph: { rich_text: [text(`${n} moment${n === 1 ? "" : "s"}, in order. Each links to its entry, where the original can be opened or played.`)] } },
    ...state.items.map((i) => ({
      type: "bulleted_list_item",
      bulleted_list_item: {
        rich_text: [text(`${i.time} · ${i.kind} · `), { type: "mention", mention: { type: "page", page: { id: i.pageId } } }],
      },
    })),
  ]);
  await save();
}

/** "2026-10-18" -> "Sun, Oct 18, 2026" */
export function displayDay(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric", year: "numeric" });
}
