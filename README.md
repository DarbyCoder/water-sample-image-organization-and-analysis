# water-sample-image-project
Organize and classify water sample images

Prof. Ahlgren's former student's project repository: https://github.com/KaviFrancis

A jupyter notebook on CNN: https://github.com/ageron/handson-mlp/blob/main/12_deep_computer_vision_with_cnns.ipynb from the collection for this book: https://github.com/ageron/handson-mlp

## Image catalog

`ProjectCode/catalog_images.py` scans the image dataset and outputs a CSV
manifest (one row per image, plus a folder summary) into
`ProjectCode/catalog_output/`. Magnification is assumed to be 10x for every
folder. When a raw folder has a `-pp` counterpart (same site, date, and
sample code), only the `-pp` folder is cataloged -- confirmed with the
professor that `-pp` is the city's standard post-processed output. Nothing on
disk is touched; rerunning the script just recomputes which folders are
included. `sample_code` is also classified into `capture_mode`
(`autoimage` for AI* codes, `trigger` for TR*/TM codes).

It also reads the FlowCam runs exported from the VBD files (see
[Particle measurements](#particle-measurements-flowcam)) in
`ProjectCode/vbd_export/`. An image the city already exported keeps its folder
and ID, and gains the measurements of the matching FlowCam particle (checked
byte for byte); runs the city export doesn't have are added from the VBD export
(`source_dataset` `FlowCam_VBD`), but only at sites the city export already has.
The measurements go to
`catalog_output/image_measurements.csv.gz` -- one row per image, ~140 MB, so
it stays out of git and is rebuilt by the script.

```bash
pip3 install Pillow
python3 ProjectCode/catalog_images.py
```

The script also cleans up the metadata (`finalize_folder` in `catalog_images.py`):

- **Sites**: spelling variants are merged and sites whose folder names don't say
  what they are get their type (`SITE_RENAMES`, `SITE_WATER_TYPES`), e.g.
  `leeseville` -> `leesville pond`, `flint`/`flint ramp` -> `flint pond`. A
  folder's `water_body_type` is always its site's type: pond, lake or reservoir
  ("park" and "shore" describe a place, not a body of water). `patch` and
  `sterling` are still unknown.
- **Not real sites** (`EXCLUDED_SITES`: `unknown`, `nolable`) are left out.
- **Dilution** is a plain number: `0.5`, `0.1`, `0.25`; "no dilution" is `1`;
  empty means it wasn't recorded (the site shows "Not recorded"). Names like
  ".1 dilution" are 0.1 (they used to be read as 1).

`python3 ProjectCode/catalog_images.py --refresh-metadata` re-applies just these
to the committed `catalog_output/` files, without the images; then import them
with `deploy/import_to_supabase.py`.

Dates show as MM/DD/YYYY on the site; folder names keep the city's own dates.

The manifest is gzipped for github (file limit) (`image_manifest.csv.gz`). To unzip it:

```bash
gunzip -k ProjectCode/catalog_output/image_manifest.csv.gz
```

## Hosting (Plan A)

The catalog is online at **https://water-sample-dashboard.pages.dev**. Anyone can
browse, filter, view and download the images without an account. Signing in
(Google, or email and password) is needed to label images (labeler role), to
manage accounts (admin role), or to request a role on the admin page. Everything runs on free tiers: Cloudflare Pages,
Workers and R2, plus Supabase.

### Architecture

```mermaid
flowchart LR
    subgraph laptop["A laptop, when images are added"]
        vbd[("FlowCam VBD files")]
        exp["Flowcam_VBD_File_Format/export_all.py"]
        runs[("vbd_export")]
        imgs[("WCMC_raw_images_2023_and_others")]
        cat["catalog_images.py"]
        imp["deploy/import_to_supabase.py"]
        meas["deploy/import_measurements.py"]
        up["deploy/upload_images.ps1 (rclone)"]
        vbd --> exp --> runs --> cat
        imgs --> cat --> imp
        cat --> meas
        imgs --> up
        runs --> up
    end
    imp -->|"folder and image rows"| db[("Supabase: Postgres + Auth")]
    meas -->|"particle measurements"| db
    up -->|"image files"| r2[("Cloudflare R2 bucket: water-sample-images")]
    r2 --> worker["Cloudflare Worker: water-sample-images (read-only)"]
    gh["GitHub: host branch"] -->|"Cloudflare builds every push"| pages["Cloudflare Pages: water-sample-dashboard"]
    gh -->|"GitHub Actions, when worker/ changes"| worker
    browser(("Visitor's browser")) -->|"HTML, JS, CSS"| pages
    browser -->|"data and sign-in (public key + Row-Level Security)"| db
    browser -->|"view and download images"| worker
```

- **Dashboard** (`ProjectCode/index.html`, `labeling.html`, `review.html`, `admin.html`,
  `reset-password.html`, `privacy.html`, `404.html`, their scripts and the shared
  `base.css`, `theme.js`, `ui.js`, `viewer.js`, ... -- see
  [Look and feel](#look-and-feel) and `ProjectCode/build.mjs` for the full list):
  a static site on Cloudflare Pages. It reads
  folders, stats, charts and image lists straight from Supabase with the public
  key in `ProjectCode/config.js`. Stats and charts come from database views and
  per-folder totals, so the browser never downloads the 500K-row images table;
  a folder's image list is loaded only when that folder is opened.
- **Images**: 565,873 PNGs (4.17 GiB) in the R2 bucket `water-sample-images`:
  511,765 from the city's export and 54,108 from the FlowCam VBD files.
  Each object key is the image's `relative_path` (`<folder>/<filename>`). The
  Worker in `ProjectCode/worker/` serves them read-only at
  `https://water-sample-images.watersampleimageorganization.workers.dev/<key>`;
  adding `?download=1` makes the browser save the file.
- **Database** (`ProjectCode/supabase/migrations/`): `001_init.sql` creates the
  tables `folders`, `images`, `qa_log` and `profiles`, the views behind the stats
  and charts, and the role functions; `002_labeling.sql` adds image labeling (see
  [Labeling](#labeling)); `003_measurements.sql` adds the FlowCam measurements
  (see [Particle measurements](#particle-measurements-flowcam)); `004_roles.sql` adds the
  Owner role and role requests; `005_label_options.sql` adds the shared label list
  and `006_blind_review.sql` blind review (see [Labeling](#labeling)). Security lives in the database (Row-Level Security and
  SQL functions), not in the page:
  - anyone can read folders, images and the QA log, and nobody can change them
    through the website, except that admins can set the `label` column of an
    image (and nothing else), and labelers can submit labels for review
    (`submit_labels()`, 006);
  - every account starts as `viewer`; `watersampleimageorganization@gmail.com`
    becomes `owner` on its first confirmed sign-in. The Owner can do everything an
    admin can; nobody can be made Owner, and the Owner's role can't be changed;
  - only admins can list accounts or change roles (admin page), only the Owner can
    change another admin's role (admins can change their own), and the last admin
    can never be demoted or deleted;
  - on the admin page, signed-in viewers can request the labeler or admin role and
    labelers the admin role; admins approve or decline in the accounts table's
    Status column;
  - labeling is switched on by applying `002_labeling.sql`: until then the
    labeling page shows a setup notice instead of the workspace.
- **Duplicates**: `catalog_images.py` already leaves out raw folders that have a
  `-pp` twin, so the hosted data has no duplicates to hide. Folders with no
  images are hidden.
- `ProjectCode/prepare_image_data.py` is **LEGACY**: it built per-folder JSON
  files for the old local-only dashboard, which now reads from Supabase instead.

### Labeling

`labeling.html` is the labeling workspace. Anyone can browse it; accounts with the
`labeler` or `admin` role can label.

- Pick a folder from the searchable list on the left (it shows each folder's
  progress and sorts the least-labeled first), then click image tiles to select them
  (Shift-click for a range). The **Label** panel beside the grid has a text box with
  the whole label list under it: type any part of a name (`m` lists Microcystis and
  Microcystis Debris first; `deb` finds Microcystis Debris), then press Enter or
  click a label. It applies straight away to every selected image.
- **Enter new label** is always last in the list. It asks for a name and a category
  and adds the label to the shared list, so every labeler sees it at once. Exact
  duplicates are refused; near-duplicates (different capitals) are allowed.
- Every label has a category: **Cyanobacteria**, **Other significant** or
  **Non-organism / Unsure**. Colours and shapes come from the category. The
  starting list (in `005_label_options.sql`): Aphanizomenon, Dolichospermum,
  Microcystis, Oscillatoria, Woronichinia, Microcystis Debris (Cyanobacteria);
  Staurastrum, Fragilaria, Dinobryon, Centric Diatom (Other significant); Blank /
  empty, Unsure (Non-organism / Unsure).
- On the admin page, labelers and admins see every label and how many images use
  it. Admins can change a label's category at any time, and rename or delete a label
  no image uses yet (the database enforces this: `admin_update_label()`,
  `admin_delete_label()`). A starting label that was deleted comes back the next time
  `apply_migrations.py` runs.
- Every tile also has its own label box (click its label), and Enter or the expand
  button opens the viewer (zoom, pan, filmstrip, the same label box, "label and move
  on") for careful one-by-one work.
- Changes appear instantly and save in the background; if a save fails the images
  are put back and a message says so. **Undo** (Z) works across everything.
- `labeled_by` and `labeled_date` are stamped by a database trigger from the signed-in
  user and the current time; the browser can write nothing but `label`.
- Progress shows as an overall ring, a per-label mix, per-folder bars (also on the
  dashboard) and a per-labeler table on the admin page, for admins and labelers
  (labelers see names, not email addresses). **Export labels (CSV)**, also on the
  admin page, downloads image id, folder, filename, label, category and time. The
  **Show** filter picks a category or a single label.
- Keyboard: arrows move, Space selects, Enter opens the viewer, `/` (or `L`) goes to
  the label box (with nothing selected it labels the focused or hovered image), ↑ ↓
  and Enter pick a label, Esc goes back to the images, `0` clears, `Z` undoes, `?`
  lists every shortcut.
- `images.label` stores the label's name exactly as shown, and the database refuses
  a name that isn't on the list (`images_check_label` trigger).

**Blind review** (`supabase/migrations/006_blind_review.sql`). A labeler's label
is *in review* until one other labeler picks the same label on the **Review**
page (`review.html`) without seeing it, or an admin reviews it; then it's
*official*. A different pick makes it *disputed*, and an admin settles it on the
Review page's Disputed tab. An admin's own label is official straight away.

- `images.label` only ever holds the official label, so the catalog, counts and
  CSV export show official labels only. Labels from before 006 stay official.
- Pending labels live in `pending_labels`, which nobody reads directly; the
  functions show a pending label only to whoever gave it and to admins, so
  other labelers see "In review" (hidden and locked) in the grid.
- Labelers save through `submit_labels()`; only admins update `images.label`
  directly. A labeler can propose a change to an official label (it stays
  official until the change is confirmed) and withdraw their own pending
  label, but only admins clear an official label. Changing a label starts its
  review over, and nobody reviews their own label.
- A confirmed label is credited (`labeled_by`) to the labeler, not the reviewer.
- The reviewer is told the first label afterwards, never who gave it.
- Folder progress counts pending labels as done (for labelers' to-do lists);
  the overall ring counts official labels only.
- Until 006 is applied, labels are official as soon as they're saved, and the
  Review page says the database needs 006.

Demo mode runs the same functions on sample data (`demo.js`), and the demo
pill's **Acting as** menu switches between sample labelers and an admin to try
the whole loop.

Not set up yet, or want to show it off? Add `?demo` to any page's address
(`labeling.html?demo`). Demo mode runs the catalog and labeling on sample data and
generated images with no database, and nothing is saved anywhere. Anyone can label
the sample images, signed in or not. Accounts stay real: the demo never signs you in
or out, and your header and role are your own. The pill at the bottom has Reset and
Exit; `?demo=0` also turns it off.

### Particle measurements (FlowCam)

The FlowCam's own files (`.VBD`, one per sampling day, 2021–2024) hold every
particle's image and about 80 measurements. `Flowcam_VBD_File_Format/` decodes
them (see its README); 64 of the measurements vary in our data, and the
dashboard can filter on all of them.

- Under **Find a sample → Particle measurements**, **Add measurement** lists them
  by group (Size, Shape, Colour and intensity, Fluorescence, Capture, Pixel
  measurements) with a search box. Each filter is a range: drag the two handles
  (wide ranges like biovolume use a logarithmic scale) or type a minimum and/or
  maximum. Below each one, "Most images" shows the 1st–99th percentile.
- With a range set, the table lists only folders with images inside every range
  and shows how many match out of the folder's total; the stats and charts count
  matching images, and a folder's panel lists only its matching images, with a
  column for each measurement. The ranges are kept in the address
  (`#m_diameter_esd=20~50`), so a filtered view can be shared.
- 565,778 of the 565,873 cataloged images have measurements. The 95 images in
  `Salisbury_4.19.23_10x_TR1 0.5` don't: none of the VBD files has that run.
- The values are stored as `real` columns on `images` (62 new columns; the pixel
  width and height were already there), and `measurement_columns` describes
  each filter. Loading them adds about 140 MB to the database.
- The folder counts are made in the browser. Counting in the database means
  reading the whole ~300 MB images table, which takes 8–12 seconds on the free
  tier, past Supabase's 3-second limit for visitors. Instead,
  `deploy/build_filter_data.py` writes one file per measurement holding every
  image's value (2.2 MB each), and `upload_images.ps1` puts them in R2 under
  `_filters/`. The dashboard downloads a measurement's file the first time it's
  used; after that a filter change takes a few milliseconds. The files hold the
  same 4-byte floats as the database, so the counts match the folder panel
  (which still asks the database) exactly. If the files don't match the
  catalog, for example after an import without the upload, the dashboard says
  the filters are unavailable instead of showing wrong counts.
- `measurement_folder_counts()` (migration 003) counts the same way in the
  database. It's too slow for the website, but fine for scripts.
- Demo mode (`?demo`) has 13 of the measurements, with made-up values.

### Look and feel

The pages share one design system: `base.css` (light and dark themes as CSS
variables, typography, buttons, forms, cards, toasts, dialogs), plus
`dashboard.css`, `labeling.css` and `viewer.css` for the individual screens.

- **Light / dark mode** follows the operating system until the visitor picks one
  with the sun/moon button; `theme.js` applies it before the first paint so there is
  no flash. All colours are variables, and the palette passes WCAG AA contrast in
  both themes.
- **Text size**: **Change Text Size** on the catalog page sets 1× to 4× (in 0.1
  steps) for every page, remembered in the browser. `theme.js` scales the root font
  size, so rem-sized text, spacing and panels grow together, and switches to the
  stacked narrow-screen layouts when the text gets large for the window. The big stat
  numbers, the donut totals, the hero title and the text inside the graphs keep their
  size (they use `--rem0` or pixels).
- **Fonts** are self-hosted in `ProjectCode/fonts/` (Fraunces for headings and a
  Cambria-compatible face for text, so no third-party font service is contacted).
  Cambria is used where installed.
- Icons live in one sprite (`icons.svg`); effects (drifting plankton, waves,
  confetti) in `fx.js`. Motion respects "reduce motion".

### Where secrets live

| What | Where | In git? |
|---|---|---|
| Database connection string and R2 keys | `ProjectCode/.env`, on the laptop that runs the import/upload (copy `ProjectCode/.env.example`) | No, gitignored |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | GitHub repository secrets, used by the Worker deploy workflow | No |
| Google OAuth client ID and secret | Supabase dashboard (Authentication → Providers → Google) and Google Cloud Console | No |
| Supabase URL, publishable key, Worker URL | `ProjectCode/config.js` | Yes. These are public by design; what they allow is decided by Row-Level Security |

All cloud accounts belong to `watersampleimageorganization@gmail.com`.

### Adding new images (catalog → import → upload)

Run these from `ProjectCode/` in PowerShell. One-time setup on a new machine:
Python 3, Node 22+ and [rclone](https://rclone.org/), then:

```powershell
pip install Pillow -r deploy/requirements-deploy.txt
Copy-Item .env.example .env   # then fill in the real values
```

1. Put the new sample-event folders into `WCMC_raw_images_2023_and_others/`.
   Don't rename or move existing folders: an image's ID and storage key come
   from its folder and file name.
2. For FlowCam measurements (and runs the city export doesn't have), export the
   VBD files -- a folder of them, or a `.zip` -- into `vbd_export/`. Files
   already exported are skipped, so it's quick to re-run after adding one.
   About 10 GB of VBDs take 30–60 minutes and ~15 GB of disk (6 GB of it SQLite
   databases in `Flowcam_VBD_File_Format/out/sqlite`, which can be deleted
   afterwards).
   ```powershell
   pip install pandas
   python ..\Flowcam_VBD_File_Format\export_all.py C:\path\to\Worcester_FlowCam.zip vbd_export
   ```
3. Rebuild the catalog. It opens every image and checks the city's images
   against the VBD export byte for byte, so expect 30–60 minutes:
   `python catalog_images.py`
4. Check, then import into Supabase. One transaction adds new rows, updates
   changed ones and removes ones no longer in the catalog. It never touches
   labels or measurements, and refuses to commit if the counts don't match or
   if it would remove a labeled image. `--dry-run` lists what it would remove.
   ```powershell
   python deploy/import_to_supabase.py --dry-run
   python deploy/import_to_supabase.py
   ```
5. Load the measurements (after `003_measurements.sql` is applied, below). It
   goes in batches of 25,000 so the free database never needs room for two
   copies of the images table; if it stops part-way, run it again.
   ```powershell
   python deploy/import_measurements.py --dry-run
   python deploy/import_measurements.py
   ```
6. Upload the images, from `WCMC_raw_images_2023_and_others/` and `vbd_export/`
   (chosen by each image's `source_dataset`). The file list comes from the
   database, so import first. Images already in R2 are skipped, so only new ones
   count against the free write allowance. It then rebuilds and uploads the
   measurement filter files, so run it after every import, even with no new
   images. At the end it compares counts and checks 20 random images from each
   folder. If the import removed images,
   `-Prune` deletes them from R2 too (it refuses to delete more than 20% of the
   bucket):
   ```powershell
   powershell -ExecutionPolicy Bypass -File deploy\upload_images.ps1 -DryRun
   powershell -ExecutionPolicy Bypass -File deploy\upload_images.ps1
   powershell -ExecutionPolicy Bypass -File deploy\upload_images.ps1 -Prune -DryRun
   powershell -ExecutionPolicy Bypass -File deploy\upload_images.ps1 -Prune
   ```
7. Commit the regenerated `catalog_output/folder_summary.csv` and
   `catalog_output/image_manifest.csv.gz` (`image_measurements.csv.gz` is
   gitignored). Nothing needs redeploying: the dashboard reads the live data.

Whenever a file in `supabase/migrations/` is new or changes (the first time that
includes `002_labeling.sql` and `003_measurements.sql`), apply them all with
`python deploy/apply_migrations.py`. It is safe to re-run and checks the result.

### Deploys

- **Dashboard**: the Cloudflare Pages project `water-sample-dashboard` is
  connected to the GitHub repository and rebuilds on every push to the `host`
  branch. Build settings: root directory `ProjectCode`, build command
  `node build.mjs`, output directory `dist`. `build.mjs` copies only the web
  files, so nothing else in the repository is ever published. The Pages project
  is connected to the fork
  [DarbyCoder/water-sample-image-organization-and-analysis](https://github.com/DarbyCoder/water-sample-image-organization-and-analysis),
  so `host` must be pushed there to deploy. ("Retry deployment" in Cloudflare
  rebuilds that deployment's original commit, not the latest one.)
- **Image Worker**: `.github/workflows/deploy.yml` runs `wrangler deploy` when a
  push to `host` changes `ProjectCode/worker/`, or on demand from the Actions
  tab (Run workflow; GitHub only shows that button once the workflow file is
  also on the default branch, `main`). It needs the two Cloudflare secrets in
  the repository where it runs; GitHub also keeps Actions off on forks until
  they're enabled.
- **Database schema**: applied by hand with `deploy/apply_migrations.py` (above).

### Local development

```powershell
cd ProjectCode
python -m http.server 8000 --bind 127.0.0.1
```

Then open http://localhost:8000. The local page uses the live Supabase project
and image Worker.

- **Keep `--bind 127.0.0.1`.** Without it, anyone on the same network could
  download `ProjectCode/.env`.
- This server doesn't tell the browser when files change, so hard-reload
  (Ctrl+Shift+R) after editing.
- `http://localhost:8000/**` must stay in Supabase's Redirect URLs for sign-in
  to work locally.
- To run the Worker locally: from `ProjectCode/worker`, run `npm install`, load
  a few images into the local test bucket with
  `node scripts/seed-local.mjs "<folder>/<file.png>"`, then `npx wrangler dev`.

### Free-tier limits

| Service | Free limit | This project |
|---|---|---|
| Supabase database | 500 MB | about 348 MB with the FlowCam images and measurements (the import scripts refuse to go past 450 MB; Postgres reuses space freed by removed rows rather than shrinking the file) |
| Supabase activity | Pauses after about 7 days with no requests | See below |
| Supabase sign-in emails | Built-in sender allows only a few emails per hour | Fine for a handful of users; add custom SMTP for more |
| Cloudflare R2 storage | 10 GB | 4.17 GB of images (3.65 GB city export, 0.52 GB FlowCam), plus 0.14 GB of measurement filter files |
| R2 writes (Class A) | 1M per month | The first full upload used about 512K; later runs only upload new images |
| R2 reads (Class B) | 10M per month | One per image viewed or downloaded |
| Cloudflare Workers | 100,000 requests per day | One per image viewed or downloaded |
| Cloudflare Pages | 500 builds per month | One per push to `host` |

**If Supabase is paused**, the dashboard shows "Couldn't load the catalog
data". Sign in to supabase.com as the project account, open the project and
click **Restore project**. It takes a few minutes and keeps all data. Don't
leave it paused for months: Supabase keeps paused free projects restorable
for a limited time only.

### Known limitations

- **Scripted downloads need a User-Agent.** Cloudflare blocks Python's default
  `urllib` User-Agent (HTTP 403, error 1010). Send one, for example
  `urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})`.
- **"Download All Visible" is capped at 200 images per click** and saves them
  one at a time; browsers may ask to allow multiple downloads.
- **Google sign-in shows the Supabase address.** The consent screen says
  "continue to gchpxdizablwgijbgzhc.supabase.co" unless Google brand
  verification or a paid Supabase custom domain is set up. It only works for
  listed test users until the app is published in Google Auth Platform.
- **Sign-up and password-reset emails** are limited by Supabase's built-in
  email sender (see above).
- **The QA log is empty.** `catalog_images.py` no longer writes `qa_log.csv`;
  the import loads it if the file exists.
- **Some filter values are spelled inconsistently** in the source folder names
  (for example `0.1 Dilution` and `0.1 dilution`, or `1dilution` and
  `1 dilution`), so they appear as separate options. 12 of the folders added
  from the VBD files have no water-body type.
- **FlowCam runs at sites the city export doesn't have are left out.** The
  catalog skips them, which removes 12 runs (17,835 images) at 7 site names:
  duplicates (`CoesDup`, `PatchDup`), misspellings (`CoesReswevoir`,
  `Washacum`) and one-offs (`933greenish`, `9am`, `SterlingELW`). Their images
  stay in `vbd_export/`.
- **Some `-pp` runs added from the VBD files may hold particles a city export
  would have left out.** In 72 of the city's 573 `-pp` exports, particles were
  dropped (47,285 in all; Indian Lake on 5.27.23 kept 72 of 155), and the VBD
  files don't record which ones. Runs the city exported use the city's images,
  so none of those particles is on the site; the 57 `-pp` runs that only exist
  in the VBD files keep every particle.
- **Each measurement filter downloads 2.2 MB** the first time it's used in a
  visit (see [Particle measurements](#particle-measurements-flowcam)).
- **Avoid reading the whole images table from the website.** At ~300 MB it
  takes longer than Supabase allows a visitor's request (3 s). That's why
  `labeling_stats` totals the per-folder image counts and the labeling queries
  use the indexes on `label` and `labeled_by`.
- **Applying `005_label_options.sql` clears labels from the old placeholder set**
  (cyanobacteria, diatom, other_organism, debris, blank, unsure): they aren't on the
  new list. Export the labels first if any are worth keeping.
- **Bulk labeling is chunked**: selections are saved 200 images per request, so a
  selection of thousands takes a moment to finish saving.
