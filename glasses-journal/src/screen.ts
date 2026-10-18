// Decides whether a photo belongs in Legacy's Life Journal, and suggests a
// title for it, from a small preview image. Claude is asked only whether a
// baby or young toddler appears; it does not and cannot recognize who the child is.

import Anthropic from "@anthropic-ai/sdk";

export interface ScreenResult {
  include: boolean;
  reason: string;
  title?: string;
}

const PROMPT =
  "You are screening a parent's camera roll for their baby daughter's private life journal. " +
  "Decide whether this image shows a baby or young toddler (roughly under 3 years old), even if only partly visible " +
  "(e.g. hands, feet, the back of their head, being held). Do not try to identify who the child is. " +
  "Images without a baby or toddler (adults only, pets, places, food, documents, screenshots) are not included. " +
  "If included, also write a short, factual title (at most 8 words) describing what is happening, without names.";

const SCHEMA = {
  type: "object",
  properties: {
    include: { type: "boolean" },
    reason: { type: "string", description: "At most 12 words: what you saw that decided it." },
    title: { type: "string", description: "Short title if included, else empty." },
  },
  required: ["include", "reason", "title"],
  additionalProperties: false,
};

/** Returns undefined when Claude couldn't answer (error or refusal), so the caller can retry later. */
export async function screenPhoto(
  opts: { apiKey: string; model: string; baseURL?: string },
  jpeg: Uint8Array,
): Promise<ScreenResult | undefined> {
  try {
    const client = new Anthropic({ apiKey: opts.apiKey, baseURL: opts.baseURL, maxRetries: 2, timeout: 60_000 });
    const response = await client.beta.messages.create({
      model: opts.model,
      max_tokens: 2000,
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: toBase64(jpeg) } },
            { type: "text", text: PROMPT },
          ],
        },
      ],
    });
    if (response.stop_reason === "refusal") return undefined;
    const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    const parsed = JSON.parse(text) as { include: unknown; reason: unknown; title: unknown };
    if (typeof parsed.include !== "boolean") return undefined;
    const title = typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim() : undefined;
    return { include: parsed.include, reason: String(parsed.reason ?? "").trim(), title: parsed.include ? title : undefined };
  } catch (err) {
    console.error("screening failed", err);
    return undefined;
  }
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
