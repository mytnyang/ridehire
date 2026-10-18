# Glasses Journal

This setup looks at the photos and videos on your iPhone, both iPhone-camera and Meta-glasses captures, and picks out the ones of **Legacy**. Each of those is:
- saved as an **untouched original** in Cloudflare R2
- given a **SHA-256 fingerprint**
- logged in **Legacy's Life Journal** in Notion

When an item is safely backed up and verified, the Shortcut adds it to a **"Backed Up"** album on your iPhone. **Nothing is ever deleted automatically.** You delete what you want from that album yourself. Each day also gets a **timeline page** listing its moments in order. **Everything that isn't of Legacy is left alone**: it isn't uploaded or logged.

```
iPhone camera roll (iPhone camera + Meta glasses via the Meta AI app)
   │  Shortcut, runs when the phone starts charging
   ▼
1. /v1/screen   small preview ─▶ Claude: "is there a baby or toddler?"
                 no  ─▶ left alone on the phone (decision remembered)
                 yes ─▶ continue
2. upload the original ─▶ R2          3. log ─▶ Legacy's Life Journal (Notion) + that day's timeline
4. verified backed up ─▶ added to the "Backed Up" album (you delete manually, if you want)
```

No computer is involved after setup.

## How Legacy is picked

- **Claude screens a small preview** of each photo and answers one question: does this show a baby or young toddler? It doesn't recognize who the child is, so occasionally another child may get in. The Notion page says why each item was picked ("Picked by AI: …").
- **Each item is checked only once.** The answer is stored under the photo's fingerprint, and the Shortcut keeps a bookmark of how far it has got, so non-Legacy photos aren't re-checked every night.
- **The "Legacy" album is your override.** Anything you add to a **Legacy** album is always logged, even if Claude said no. To keep a wrong pick out, delete its Notion row. The phone copy is kept until you decide.
- **Videos:** Claude needs a still image. If your iOS version lets the Shortcut take a frame from a video (the laptop session can check), videos are screened like photos. If not, videos are logged only when you add them to the Legacy album.
- **Cost:** roughly 1 cent per new photo screened, with the default model (`AI_MODEL`) and a 768-pixel preview. A one-time backlog of 2,000 photos is roughly $15–25. After that, it depends on how many new photos you take.
- **Privacy:** each new photo's small preview is sent to the Claude API for screening. Hidden, "Private" album and screenshot items are never sent.
- If the AI can't answer (an error or a refusal), the item is left alone and asked about again on the next run.

## Safety: nothing is deleted for you

The system **never deletes anything** from your phone. It only adds verified items to a **"Backed Up"** album. An item goes into that album only when **all** of these are true:
1. The original is archived in Cloudflare R2.
2. It's logged in Legacy's Life Journal. The Worker refuses to log anything that didn't pass screening.
3. The fingerprint the iPhone computed matches the archived original's fingerprint. The Worker returns `safeToDelete: true` only in that case.

**Rule of thumb: only delete from the "Backed Up" album.** Anything outside it may not be backed up. Before you delete, you can open an item's Notion entry and play or open its original. Deleted items still sit in **Photos → Recently Deleted for 30 days**. If iCloud Photos is on, deleting on one device deletes on all of them; the R2 copy is your archive. The Worker never deletes an original it has logged.

| What | Screened / uploaded? | Goes in "Backed Up"? |
|---|---|---|
| **Hidden** items, and anything in a **"Private"** album | No, never touched | No |
| **Screenshots** (often text-message evidence) | No, never touched | No |
| Not of Legacy (Claude said no, and not in the Legacy album) | Preview screened only | No, so don't delete it expecting a backup |
| Items of Legacy | Yes, uploaded and logged | Yes, once verified |

**First, a trial run.** After setup, run the Shortcut once and check Legacy's Life Journal:
- Are the right photos there?
- Do the originals open, and do videos play?

Then start deleting from "Backed Up" as you like.

**Optional, for evidence:** Cloudflare R2 can lock a bucket so objects can't be deleted or overwritten for a set retention period. Check the "bucket locks" section of the R2 docs; if you use it, set it on the `glasses-journal` bucket.

## Day timelines

Each day that has logged moments gets a page in Legacy's Life Journal named like **"Legacy's day · Sun, Oct 18, 2026"** and tagged `Timeline`. It lists that day's moments in time order:

```
9:00 AM · Photo · Tummy time on the blanket
3:04 PM · Video · Playing at the park
```

Each line links to its entry, where the original can be opened or played. The titles are written by the AI. The page is redrawn in order every time something from that day is logged, even if items arrive out of order during a backlog run. To see just the timelines, filter the database by the `Timeline` tag.

## Playing originals

- **Video entries** have a player at the top that streams the archived original. The "Original file" link opens it full screen. Seeking works, because the Worker serves byte ranges.
- iPhone videos are usually HEVC (`.mov`). They play in Safari and on Apple devices. Some browsers on Windows can't play HEVC; the file is fine, so download it and play it in VLC.
- If Notion ever declines the embedded player, the entry is still logged, and the "Original file" link plays it.

## What each Notion entry contains

- **Name**: a short AI-written title, e.g. "Tummy time on the blanket". Items added through the album are named like "Photo · Sep 27, 2026, 3:04 PM".
- **Date**: when it was taken, from the file itself when possible.
- **Tags**: Photo or Video, plus `Auto-logged`, so automatic entries can be filtered apart from ones you made by hand.
- **Entry** is left empty for your own notes.
- **The page body** has:
  - a preview
  - a link to the original
  - place, camera, length, file name and size
  - why it was picked
  - a *Provenance* section: the SHA-256, whether the phone's fingerprint matched, where the date and location came from, and the R2 storage name

To check a file later, run `shasum -a 256 <file>` on a Mac, or `certutil -hashfile <file> SHA256` on Windows. If even one byte has changed, the result won't match the page.

The "Original" link is long and unguessable; anyone who has it can open the file. Uploading the same file twice never creates a second entry.

## One-time setup

You need a Cloudflare account on the **Workers Paid** plan ($5/mo). Fingerprinting a long video takes more CPU time than the free plan allows. R2 storage costs about $0.015 per GB-month, and the first 10 GB are free.

### 1. Notion

1. Entries go into **Legacy's Life Journal**. Its ID is in `wrangler.jsonc`. The Worker uses only its existing Name, Date and Tags fields, and adds the `Auto-logged` tag option on first use.
2. Go to https://www.notion.so/profile/integrations, then **New integration** (internal). Copy the secret.
3. Open Legacy's Life Journal. In the **⋯** menu, go to **Connections** and add the integration. Without this step, Notion returns 404.

### 2. Anthropic API key

Create a key at https://console.anthropic.com (API keys) and add a little credit. The Worker uses it to screen photos.

### 3. Cloudflare

```sh
cd glasses-journal
npm install
npx wrangler login
npx wrangler r2 bucket create glasses-journal
```

Edit `TIMEZONE` in `wrangler.jsonc` to your IANA zone (e.g. `America/Chicago`). It's used only when a photo's EXIF has no UTC offset. Then set the secrets. Type each one into the prompt yourself; don't paste them into a chat.

```sh
npx wrangler secret put UPLOAD_TOKEN       # make up a long random string; the Shortcut sends it
npx wrangler secret put LINK_SECRET        # another long random string; signs the "Original" links
npx wrangler secret put NOTION_TOKEN       # the integration secret from step 1
npx wrangler secret put ANTHROPIC_API_KEY  # the key from step 2
```

**Recommended: direct-to-R2 uploads.** Without these keys, uploads go through the Worker, and Cloudflare caps each request at 100 MB, which a few minutes of video can exceed. To avoid the cap, go to the Cloudflare dashboard, then **R2 → Manage API tokens → Create token**. Choose *Object Read & Write* and limit it to the `glasses-journal` bucket. Then run:

```sh
npx wrangler secret put R2_ACCOUNT_ID         # shown on the R2 overview page
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
```

Deploy with `npm run deploy`. Note the URL it prints, e.g. `https://glasses-journal.<you>.workers.dev`. Then check that it responds: `curl https://glasses-journal.<you>.workers.dev/health` should return `{"ok":true}`.

### 4. iPhone prep

- **Meta AI app:** go to **Settings → your glasses → Media → Auto-import** (older app versions call it *Import automatically*) and turn it on. Glasses captures will then land in your camera roll.
- In **Photos**, create three albums:
  - **Private**: never touched
  - **Legacy**: always logged
  - **Backed Up**: the Shortcut adds verified items here, and you delete from it whenever you like

### 5. iPhone Shortcuts

You'll make three shortcuts. Replace `WORKER` with your Worker URL and `TOKEN` with your `UPLOAD_TOKEN`. If your iOS version names an action or filter differently, the laptop Claude session can help.

#### A. "Journal: Send Item"

This shortcut handles one photo or video. In its settings, set it to **receive Media input**. It also needs one variable, `InAlbum`; its value comes from the shortcut that calls it (B or C).

1. **Text**: `Shortcut Input.Name`.`Shortcut Input.File Extension`. Rename the output to `Filename`.
2. **Generate Hash** of *Shortcut Input*, type **SHA256**. Rename the output to `Hash`.
3. **Make a preview:**
   - **If** *Media Type* is **Image**: **Resize Image** to width 768, then **Convert Image** to JPEG, quality 0.7.
   - Otherwise, take a still frame from the video if your iOS can, and resize and convert it the same way.

   Rename the output to `Preview`.
4. **Get Contents of URL**:
   - URL: `WORKER/v1/screen`
   - Method: POST
   - Header: `Authorization` = `Bearer TOKEN`
   - Form fields:
     - `sha256` = *Hash*
     - `preview` = *Preview* (File)
     - `inLegacyAlbum` = *InAlbum*

   Rename the output to `Screen`.
5. **If** *Screen → retry* is true: **Stop and Output** `retry`. Nothing changes, and the item is asked about again next run.
6. **If** *Screen → include* is false: **Stop and Output** `skip`. The item is left alone.
7. **If** *Screen → alreadyLogged* is true: **Stop and Output** *Screen → safeToDelete*. No upload is needed.
8. **Get Contents of URL**:
   - URL: `WORKER/v1/uploads`
   - Method: POST
   - Header: `Authorization` = `Bearer TOKEN`
   - JSON body: `filename` = *Filename*

   Rename the output to `Start`.
9. **Get Contents of URL**:
   - URL: *Start → uploadUrl*
   - Method: PUT
   - Request Body: File = *Shortcut Input*
   - **No headers.** The upload URL is already signed.
10. **Format Date**: *Date Taken*, format ISO 8601, include time. Then **Get Details of Locations**: Latitude, Longitude and Name of *Location*.
11. **Get Contents of URL**:
    - URL: *Start → completeUrl*
    - Method: POST
    - Header: `Authorization` = `Bearer TOKEN`
    - Form fields:
      - `sha256` = *Hash*
      - `filename` = *Filename*
      - `takenAt` = the formatted date
      - `latitude`, `longitude`, `place` = the location details
      - `preview` = *Preview*
12. **Stop and Output** *Contents → safeToDelete*. It's `true` only when the item is archived, logged and fingerprint-verified.

#### B. "Photos → Journal" (new items)

1. **Get File** `journal-bookmark.txt` from the Shortcuts folder in iCloud Drive. If it's missing, use a start date, e.g. the day Legacy was born. Convert the text to a date: this is the *Bookmark*.
2. **Find Photos** where **all** of the following are true:
   - *Date Taken* is after *Bookmark*
   - *Is a Screenshot* is false
   - *Is Hidden* is false
   - *Album* is not `Private`

   Sort by Date Taken, oldest first. Limit to 50.
3. **Repeat with Each** item. Inside the loop:
   1. **Run Shortcut** "Journal: Send Item" with the item as input, and `InAlbum` = `false`.
   2. **If** the result is `retry`: **Stop This Shortcut**. The bookmark stays put, so this item is retried next run.
   3. **Adjust Date**: the item's Date Taken minus 1 second. **Save File** with that date to `journal-bookmark.txt`, overwriting the old one.
   4. **If** the result is `true`: **Add to Album** "Backed Up" with the item as input.
4. **Run Shortcut** "Legacy Album → Journal".

#### C. "Legacy Album → Journal"

This is the same as B, but simpler:
- **Find Photos** where *Album* is `Legacy` (no bookmark, no date filter).
- Run "Journal: Send Item" with `InAlbum` = `true`.
- If the result is `true`, add the item to "Backed Up".

Items already logged return immediately without re-uploading.

**First run (the backlog):** run "Photos → Journal" by hand, with the phone on Wi-Fi and charging and the Shortcuts app open. Each run handles 50 items, so repeat until it finds nothing new. It's always safe to re-run.

Then set up the automatic run: **Automation → New Automation → Charger → Is Connected → Run Immediately**, and choose "Photos → Journal". A **Time of Day** automation (e.g. 2 AM) works too.

## API

Everything except `/health`, `/m/…` and the signed upload URL needs `Authorization: Bearer $UPLOAD_TOKEN`.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/screen` | Multipart: `sha256` (of the original), `preview` (JPEG), `inLegacyAlbum`. → `{include, reason, title?}`, or `{include: true, alreadyLogged: true, safeToDelete}`, or `{include: false, retry: true}`. Decisions are cached by `sha256`; the album overrides an earlier "no". |
| `POST` | `/v1/uploads` | `{"filename":"IMG_1.jpg"}` → `{file, uploadUrl, completeUrl, direct}` |
| `PUT` | *uploadUrl* | Raw file bytes. Signed, expires in 1 h. Goes direct to R2 when R2 keys are set. |
| `POST` | `/v1/uploads/:file/complete` | Multipart: `sha256`, `filename`, `takenAt`, `latitude`, `longitude`, `place`, `preview`. Refuses items that didn't pass screening. → `{status: "logged" \| "duplicate", sha256, notionUrl, safeToDelete, timeline}`. Safe to retry. |
| `GET` | `/m/:file?sig=…` | The original file, with Range support so videos stream. |

Supported types: jpg, jpeg, heic, png, mp4, mov. Capture metadata is read from JPEG EXIF and MP4/MOV headers. For other formats, the Worker uses what the Shortcut sends.

## Development

```sh
npm test          # parser + capture-time unit tests
npm run typecheck
npm run dev       # local Worker with a local R2 bucket; put secrets in .dev.vars
```

For local testing, `NOTION_API_BASE` and `ANTHROPIC_BASE_URL` in `.dev.vars` point the Worker at mock servers.
