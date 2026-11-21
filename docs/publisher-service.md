# Automatic publication from a private Obsidian vault

The publisher container scans a synchronized vault without relying on filesystem change
notifications. It exports only notes whose YAML frontmatter contains the Boolean property
`publish: true` and a `permalink`, together with the local attachments referenced by those notes.

Quartz never receives the complete vault. Nginx receives only a successfully generated static
release.

## Where a note is published

A note is published at its `permalink`, never at its path in the vault, so the site reveals
nothing of how the vault is organised. The note stays where it is; only the copy given to Quartz
is placed at `<permalink>.md`. Every attachment a published note uses is placed in one
`attachments/` folder, by file name.

The note with `permalink: index` is the site's home page: it replaces Quartz's default one
("Welcome to Quartz"), and it is accepted whatever `PUBLISH_PERMALINK_PREFIXES` says. Without such a
note, the default home page stays.

In that copy, every link or embed that points to a published note or an attachment is rewritten
to its site path (`[[Design notes]]` becomes `[[articles/design|Design notes]]`, keeping the text
the reader sees). Links to notes that are not published are left as written: on the site they
show as links that lead to the 404 page, an honest sign of a publishing mistake.

A note marked `publish: true` is refused, left unpublished with a warning in the log, when:

- it has no `permalink`, or the permalink is not a plain relative path (no `..`, no empty part);
- `PUBLISH_PERMALINK_PREFIXES` is set (for example `blog,articles`) and the permalink does not
  start with one of those folders followed by a page name. Each prefix is a part of the site,
  with its own listing page.

A warning is logged once, when it first appears, not at every scan; it is logged again if it goes
away and comes back, and when the service restarts. A failed publication is likewise logged once
until it fails differently. Warnings name the note and never quote its text: invalid frontmatter
is reported by its line and column only.

## Publication boundary

The exporter recognizes local files referenced through:

- Obsidian wikilinks and embeds, such as `![[photo.png]]` and `[[manual.pdf]]`
- Markdown links and images
- HTML `src` and `href` attributes
- the `cover`, `image`, and `socialImage` frontmatter properties

It deliberately fails the build when:

- a required local attachment cannot be resolved;
- a short attachment name is ambiguous;
- a published note transcludes an unpublished Markdown note;
- two files would be published at the same site path (two permalinks that differ only by case,
  or two attachments with the same file name in different folders); or
- a selected source file changes while the publication snapshot is being copied.

Regular links to unpublished notes are left unresolved without copying those notes. Symbolic
links in the vault are ignored. External URLs do not cause remote content to be downloaded.

## Release layout

The host output directory has this shape:

```text
/srv/quartz-output/
├── current -> releases/<release-id>
├── releases/
│   ├── <release-id>/
│   └── <older-release-id>/
└── .publisher/
    └── state.json
```

The `current` link is replaced atomically only after Quartz finishes successfully and the new
release contains `index.html`. A failed export or build leaves the previous link untouched.

After each switch, and when the service starts, the publisher deletes old releases: it keeps the
last `KEEP_RELEASES` releases to go live (3 by default), for a rollback, and deletes the others,
so a note that is no longer published doesn't stay on disk for long. The release `current` points
to is always kept and counts among them, even after a rollback made by hand. Unfinished builds left
by an interrupted run are deleted too. Nothing else in `releases/` is touched.

## Get the publisher image

Every push to `main` builds the image with GitHub Actions (`.github/workflows/publisher-image.yaml`)
and publishes it to GitHub's container registry as `ghcr.io/<owner>/quartz-publisher`, tagged `main`
(the latest build) and `sha-<short commit>` (each build, for a rollback). A server that follows the
`main` tag, for example with Podman's auto-update, runs every push to `main`.

To build it yourself instead, from the Quartz repository:

```bash
sudo podman build --file Dockerfile.publisher --tag localhost/quartz-publisher:v5 .
```

Either way, the image build runs the publisher tests, the Quartz type check, and the formatting
check. The provided unit is a system service and therefore uses root's Podman image store; if you
convert it to a per-user service, pull or build the image with that same user instead.

## Configure systemd

Copy the provided files and edit the host paths:

```bash
sudo cp deploy/quartz-publisher.service /etc/systemd/system/
sudo cp deploy/quartz-publisher.env.example /etc/quartz-publisher.env
sudoedit /etc/quartz-publisher.env
```

The account running the service must be able to read `VAULT_HOST_DIR` and write
`OUTPUT_HOST_DIR`. The container doesn't need root: it runs as any user, one the image doesn't know
included (`--user <uid>:<gid>`, for example the vault's owner, so the vault is read through its
normal permissions), as long as that user can write `OUTPUT_HOST_DIR`. Every build of the image
checks this by publishing a note as an unknown user, with no network and no capabilities. If SELinux is enforcing, assign an appropriate container-readable label to
the vault and a container-writable label to the output directory instead of broadly disabling
label enforcement.

Then enable the service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now quartz-publisher.service
sudo journalctl --unit quartz-publisher.service --follow
```

With the defaults, a changed publication set must be identical in two scans one minute apart.
This avoids dependence on unreliable mount watchers and reduces the chance of building during a
sync operation. If a source changes while being copied, verification aborts the release anyway.

## Configure Nginx

Point Nginx only at the generated `current` link, never at the synchronized vault:

```nginx
server {
    listen 80;
    server_name notes.example.com;

    root /srv/quartz-output/current;
    index index.html;
    error_page 404 /404.html;

    location / {
        try_files $uri $uri.html $uri/ =404;
    }
}
```

The site's Quartz configuration is not part of this repository: the image is built with Quartz's
defaults (`quartz.config.default.yaml`), and each deployment supplies its own `quartz.config.yaml`,
mounted read-only over `/usr/src/app/quartz.config.yaml` (`QUARTZ_CONFIG_HOST_FILE` in the unit).
Start it from `quartz.config.default.yaml` and set at least `baseUrl` to the public hostname, so
RSS, sitemap and social metadata use the correct canonical URL. Keep the same plugin list as the
defaults: plugins are installed when the image is built.

To serve the fonts from the site itself, so visitors' browsers never contact Google Fonts, set both
`configuration.theme.fontOrigin: local` and `configuration.fonts.fontOrigin: local`. The fonts of
the default typography are in `quartz/static/fonts` (with their licences), declared in
`quartz/styles/custom.scss`; another font needs its files there and its own `@font-face` rules.

## Manual one-shot validation

The same image can perform one scan and exit:

```bash
podman run --rm \
  --network none \
  --volume /srv/sync/obsidian-vault:/vault:ro \
  --volume /srv/quartz-output:/output:rw \
  --env RUN_ONCE=true \
  localhost/quartz-publisher:v5
```

Inspect `/srv/quartz-output/current` and `.publisher/state.json` before connecting Nginx.
