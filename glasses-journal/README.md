# Glasses Journal

This setup takes every photo and video from your iPhone, both iPhone-camera and Meta-glasses captures, and does three things with each one:
- Saves the **untouched original** in Cloudflare R2.
- Computes a **SHA-256 fingerprint** of it.
- Adds a row to **Legacy's Life Journal** in Notion. The row has Name, Date and Tags (Photo/Video plus `Auto-logged`). The page body holds a preview, the place and camera, the fingerprint, and a signed link to the original.

After that, the phone copy can be deleted to free up space, following strict safety rules (see **Safety rules** below).

```
Meta glasses ──(Meta AI app auto-import)──▶ iPhone camera roll ◀── iPhone camera
      ──(Shortcut, runs when the phone starts charging)──▶ this Worker ──▶ R2 (originals)
                                                                     └──▶ Notion (one row per file)
```

No computer is involved after setup. Everything goes from the phone over Wi-Fi or cellular.

## Safety rules: nothing sensitive gets deleted

| What | Uploaded and logged? | Deleted from phone? |
|---|---|---|
| **Hidden** items, and anything in a **"Private"** album | No, never touched | No |
| **Screenshots** (often text-message evidence) | No, never touched | No |
| **♥ Favorites**, e.g. MVA evidence you want on hand | Yes | **No, always kept** |
| Everything else | Yes | Only when all the checks below pass |

An item is deleted only if **every** one of these is true:
1. The Worker stored the original and logged it in Notion.
2. The fingerprint the iPhone computed matches the fingerprint the Worker computed on arrival. The Worker returns `safeToDelete: true` only in that case.
3. You tap **Delete** on iOS's confirmation. Apple requires this, and it can't be skipped.

Even then, deleted items sit in **Photos → Recently Deleted for 30 days**. If iCloud Photos is on, deleting on one device deletes on all of them; the R2 copy is your archive. The Worker never deletes an original it has logged. The only things it removes are a redundant second upload of a file it already has, or an upload whose fingerprint didn't match (the phone still has that one).

**Roll it out in two stages.** Build the Shortcut **without** the delete step first. Run it, then open a few Notion entries and their "Original" links to check that everything is there. Only then add the delete step.

**Optional, for evidence:** Cloudflare R2 can lock a bucket so objects can't be deleted or overwritten for a set retention period. Check the "bucket locks" section of the R2 docs; if you use it, set it on the `glasses-journal` bucket.

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

1. Rows go into **Legacy's Life Journal**. Its ID is in `wrangler.jsonc`. The Worker uses only its existing Name, Date and Tags fields, and adds the `Auto-logged` tag option on first use.
2. Go to https://www.notion.so/profile/integrations, then **New integration** (internal). Copy the secret.
3. Open Legacy's Life Journal. In the **⋯** menu, go to **Connections** and add the integration. Without this step, Notion returns 404.

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

Go to **Settings → your glasses → Media → Auto-import** (older app versions call it *Import automatically*) and turn it on. Glasses captures will then land in your camera roll, where the Shortcut picks them up with everything else.

Before the first run, set up the opt-outs:
- Create an album named **Private** in Photos.
- ♥ anything you want kept on the phone.

### 4. iPhone Shortcut: "Photos → Journal"

In the Shortcuts app, create a new shortcut with these actions. Replace `WORKER` with your Worker URL and `TOKEN` with your `UPLOAD_TOKEN`. If your iOS version names a filter differently, the laptop Claude session can help you find it.

1. **Find Photos** where **all** of the following are true:
   - *Is a Screenshot* is false
   - *Is Hidden* is false
   - *Album* is not `Private`

   Sort by *Date Taken, Oldest First*. Limit to 25.
2. **Repeat with Each** item in *Photos*. Inside the loop:
   1. **Text**: `Repeat Item.Name`.`Repeat Item.File Extension`. Rename the output to `Filename`.
   2. **Generate Hash** of *Repeat Item*, type **SHA256**. Rename the output to `Hash`. **Don't skip this step**: without it, nothing is ever marked safe to delete.
   3. **Get Contents of URL**:
      - URL: `WORKER/v1/uploads`
      - Method: POST
      - Header: `Authorization` = `Bearer TOKEN`
      - Request Body: JSON, with `filename` = *Filename*

      Rename the output to `Start`.
   4. **Get Contents of URL**:
      - URL: *Start → uploadUrl*
      - Method: PUT
      - Request Body: File = *Repeat Item*
      - **No headers.** The upload URL is already signed.
   5. **Format Date**: *Repeat Item.Date Taken*, format **ISO 8601**, include time. Rename the output to `Taken`.
   6. **Get Details of Locations**: *Latitude*, *Longitude* and *Name* of *Repeat Item.Location*. These can be blank.
   7. **If** *Repeat Item.Media Type* is **Image**:
      - **Resize Image** to width 1200
      - **Convert Image** to JPEG, quality 0.8

      Rename the output to `Preview`.
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

      Rename the output to `Result`.
   9. **Stage 2 only.** **If** *Result → safeToDelete* is true **and** *Repeat Item.Is Favorite* is false, then **Add to Variable** `ToDelete` ← *Repeat Item*.
3. **Stage 2 only.** After the loop: **If** *ToDelete* has any value, add **Delete Photos** with input *ToDelete*. iOS shows a confirmation with the count. Tap Delete only if the number looks right.

**First run (the backlog):** run the Shortcut by hand, with the phone on Wi-Fi and charging and the Shortcuts app open. Each run handles 25 items, so repeat until it finds nothing new. It's safe to re-run: files already logged come back as `duplicate` and never create a second row.

Then set up the automatic run: **Automation → New Automation → Charger → Is Connected → Run Immediately**, and choose this shortcut. A **Time of Day** automation (e.g. 2 AM) works too.

## API

Everything except `/health`, `/m/…` and the signed upload URL needs `Authorization: Bearer $UPLOAD_TOKEN`.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/uploads` | `{"filename":"IMG_1.jpg"}` → `{file, uploadUrl, completeUrl, direct}` |
| `PUT` | *uploadUrl* | Raw file bytes. Signed, expires in 1 h. Goes direct to R2 when R2 keys are set. |
| `POST` | `/v1/uploads/:file/complete` | Multipart form: `sha256`, `filename`, `takenAt`, `latitude`, `longitude`, `place`, `preview`. Fingerprints, logs to Notion → `{status: "logged" \| "duplicate", sha256, notionUrl, safeToDelete}`. `safeToDelete` is true only when the phone's `sha256` matched. Safe to retry. |
| `GET` | `/m/:file?sig=…` | The original file, with Range support so videos stream. |

Supported types: jpg, jpeg, heic, png, mp4, mov. Capture metadata is read from JPEG EXIF and MP4/MOV headers. For other formats, the Worker uses what the Shortcut sends.

## Development

```sh
npm test          # parser + capture-time unit tests
npm run typecheck
npm run dev       # local Worker with a local R2 bucket; put secrets in .dev.vars
```

Set `NOTION_API_BASE` in `.dev.vars` to point the Worker at a mock Notion server during local testing.
