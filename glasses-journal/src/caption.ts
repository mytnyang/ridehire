// Optional one-line caption for a photo, written by Claude. Never blocks logging:
// any failure or refusal just means the row is titled by date instead.

import Anthropic from "@anthropic-ai/sdk";

const PROMPT =
  "This photo was taken hands-free with camera glasses by a parent, for a private family journal. " +
  "Write one short, factual caption (at most 15 words) describing what is happening. " +
  "Describe only what is visible; do not guess anyone's name or identity. Reply with only the caption.";

export async function captionPhoto(
  apiKey: string,
  model: string,
  jpeg: Uint8Array,
): Promise<string | undefined> {
  try {
    const client = new Anthropic({ apiKey, maxRetries: 1, timeout: 60_000 });
    const response = await client.beta.messages.create({
      model,
      max_tokens: 2000,
      output_config: { effort: "low" },
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
    const caption = response.content
      .flatMap((b) => (b.type === "text" ? [b.text] : []))
      .join(" ")
      .trim()
      .replace(/^"|"$/g, "");
    return caption || undefined;
  } catch (err) {
    console.error("caption failed", err);
    return undefined;
  }
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
