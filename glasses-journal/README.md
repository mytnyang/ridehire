# Glasses Journal

This setup takes photos and videos from Meta glasses and does three things with each one:
- Saves the **untouched original** in Cloudflare R2.
- Computes a **SHA-256 fingerprint** of it.
- Adds a row to the **Glasses Journal** database in Notion. The row includes the capture time, location, camera, a preview, an optional AI caption, and a signed link to the original.

```
Meta glasses ──(Meta AI app auto-import)──▶ iPhone camera roll
      ──(Shortcut, runs when the phone starts charging)──▶ this Worker ──▶ R2 (originals)
                                                                     └──▶ Notion (one row per file)
```

Meta has no API for pulling media from the glasses or from Meta's cloud. The iPhone is a short stop along the way. Once a file is logged, the phone copy can be deleted.

## What the Notion row proves

- **SHA-256** is the fingerprint of the original file, computed twice:
  - on the iPhone, before upload
  - by the Worker, on arrival

  If the two don't match, the upload is rejected. If even one byte of the original changes, its fingerprint changes. To check a file later, run `shasum -a 256 <file>` on a Mac, or `certutil -hashfile <file> SHA256` on Windows, and compare the result with the row.
- **Taken** comes from the file itself when possible. The page's *Provenance* section says which source was used:
  - camera EXIF with its UTC offset
  - the iPhone Photos library's zone-aware date
  - zoneless EXIF, read in `TIMEZONE`
  - the video header
  - the upload time, as a last resort
- **Original** is a long, unguessable signed link. Anyone who has the link can open the file. The originals themselves are never modified.
- Uploading the same file twice doesn't create a second row. The Worker returns the existing row instead.

## One-time setup

You need a Cloudflare account on the **Workers Paid** plan ($5/mo). Fingerprinting a long video takes more CPU time than the free plan allows. R2 storage costs about $0.015 per GB-month, and the first 10 GB are free.

### 1. Notion

1. The **Glasses Journal** database already exists in your workspace. Its ID is in `wrangler.jsonc`.
2. Go to https://www.notion.so/profile/integrations, then **New integration** (internal). Copy the secret.
3. Open the Glasses Journal database. In the **⋯** menu, go to **Connections** and add the integration. Without this step, Notion returns 404.

### 2. Cloudflare

```sh
cd glasses-journal
npm install
npx wrangler login
npx wrangler r2 bucket create glasses-journal
```

Edit `TIMEZONE` in `wrangler.jsonc` to your IANA zone (e.g. `America/New_York`). It's used only when a photo's EXIF has no UTC offset. Then set the secrets:

```sh
npx wrangler secret put UPLOAD_TOKEN      # make up a long random string; the Shortcut sends it
npx wrangler secret put LINK_SECRET       # another long random string; signs the "Original" links
npx wrangler secret put NOTION_TOKEN      # the integration secret from step 1
```

**Recommended: direct-to-R2 uploads.** Without these keys, uploads go through the Worker, and Cloudflare caps each request at 100 MB. A few minutes of 3K video can exceed that. To avoid the cap, go to the Cloudflare dashboard, then **R2 → Manage API tokens → Create token**. Choose *Object Read & Write* and limit it to the `glasses-journal` bucket. Then run:

```sh
npx wrangler secret put R2_ACCOUNT_ID         # shown on the R2 overview page
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
```

**Optional: captions.** With `ANTHROPIC_API_KEY` set, each photo's title becomes a one-line description, such as "Child feeding ducks at a pond". Without the key, titles look like "Photo · Sep 27, 2026, 3:04 PM". The model is set by `CAPTION_MODEL`.

```sh
npx wrangler secret put ANTHROPIC_API_KEY
```

Deploy with `npm run deploy`. Note the URL it prints, e.g. `https://glasses-journal.<you>.workers.dev`. Then check that it responds: `curl https://glasses-journal.<you>.workers.dev/health` should return `{"ok":true}`.

### 3. Meta AI app

Go to **Settings → your glasses → Media → Auto-import** (older app versions call it *Import automatically*) and turn it on. New captures will then land in the camera roll, in an album the app creates. Open **Photos → Albums** and note that album's exact name, e.g. *Meta AI* or *Meta View*.

### 4. iPhone Shortcut: "Glasses → Journal"

In the Shortcuts app, create a new shortcut with these actions. Replace `WORKER` with your Worker URL and `TOKEN` with your `UPLOAD_TOKEN`.

1. **Find Photos**
   - Filter: *Album is* `<the Meta album>`
   - Sort: *Date Taken, Oldest First*
   - Limit: 25
2. **Repeat with Each** item in *Photos*. Inside the loop:
   1. **Text**: `Repeat Item.Name`.`Repeat Item.File Extension`. Rename the output to `Filename`.
   2. **Generate Hash** of *Repeat Item*, type **SHA256**. Rename the output to `Hash`.
   3. **Get Contents of URL**:
      - URL: `WORKER/v1/uploads`
      - Method: POST
      - Header: `Authorization` = `Bearer TOKEN`
      - Request Body: JSON, with `filename` = *Filename*

      Rename the output to `Start`.
   4. **Get Contents of URL**:
      - URL: *Start → uploadUrl*. Use Get Dictionary Value, or tap the variable and pick the key.
      - Method: PUT
      - Request Body: File = *Repeat Item*
      - **No headers.** The upload URL is already signed.
   5. **Format Date**: *Repeat Item.Date Taken*, format **ISO 8601**, include time. Rename the output to `Taken`.
   6. **Get Details of Locations**: *Latitude*, *Longitude* and *Name* of *Repeat Item.Location*. These can be blank.
   7. **If** *Repeat Item.Media Type* is **Image**:
      - **Resize Image** to width 1200
      - **Convert Image** to JPEG, quality 0.8

      Rename the output to `Preview`. For videos, leave `Preview` empty.
   8. **Get Contents of URL**:
      - URL: *Start → completeUrl*
      - Method: POST
      - Header: `Authorization` = `Bearer TOKEN`
      - Request Body: **Form**, with these fields:
        - `sha256` = *Hash*
        - `filename` = *Filename*
        - `takenAt` = *Taken*
        - `latitude`, `longitude`, `place` = the location details
        - `preview` = *Preview* (field type File)
   9. **If** *Contents of URL → status* is `logged` or `duplicate`, then **Add to Variable** `Done` ← *Repeat Item*.
3. After the loop, optionally add **Delete Photos** with input *Done* to free up the phone.
   - iOS always asks you to confirm.
   - Deleted items sit in *Recently Deleted* for 30 days.
   - With iCloud Photos on, they're removed from iCloud too. The R2 copy is your archive.

Then go to **Automation → New Automation → Charger → Is Connected → Run Immediately** and choose this shortcut. It runs whenever you plug in, and a failed file is simply retried next time. A **Time of Day** automation (e.g. 2 AM) works too.

## API

Everything except `/health`, `/m/…` and the signed upload URL needs `Authorization: Bearer $UPLOAD_TOKEN`.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/uploads` | `{"filename":"IMG_1.jpg"}` → `{file, uploadUrl, completeUrl, direct}` |
| `PUT` | *uploadUrl* | Raw file bytes. Signed, expires in 1 h. Goes direct to R2 when R2 keys are set. |
| `POST` | `/v1/uploads/:file/complete` | Multipart form: `sha256`, `filename`, `takenAt`, `latitude`, `longitude`, `place`, `preview`. Fingerprints, logs to Notion → `{status: "logged" \| "duplicate", sha256, notionUrl}`. Safe to retry. |
| `GET` | `/m/:file?sig=…` | The original file, with Range support so videos stream. |

Supported types: jpg, jpeg, heic, png, mp4, mov. Capture metadata is read from JPEG EXIF and MP4/MOV headers. For other formats, the Worker uses what the Shortcut sends.

## Development

```sh
npm test          # parser + capture-time unit tests
npm run typecheck
npm run dev       # local Worker with a local R2 bucket; put secrets in .dev.vars
```

Set `NOTION_API_BASE` in `.dev.vars` to point the Worker at a mock Notion server during local testing.
