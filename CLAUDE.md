This repository is AI-managed. These agent rules apply only to the owner's own agents, not to anyone else's.

It is Quartz (upstream: `https://github.com/jackyzha0/quartz`, branch `v5`) plus a publisher service that builds a public site from the notes of a private Obsidian vault. How the publisher works and how to run it: `docs/publisher-service.md`.

## Tenets

What the publisher must do, set by the owner. They outweigh any technical choice.

- Marking a note is all it takes to publish it: after that it goes online by itself.
- Publishing is an explicit opt-in, note by note (`publish: true`), never by folder or by default.
- A note is published from where it lives, as it is: publishing never requires moving a note or restructuring the vault.
- The site never shows where a note sits in the vault: a note is published at its `permalink`, and a note without one is refused.
- A note that isn't published never goes out because a published note links to it.
- A link to an unpublished note stays visible as a link that leads nowhere, so a publishing mistake shows as one; it is never hidden or removed.
- Quartz's own frontmatter fields are the starting point (`publish`, `permalink`, `title`, `description`, `tags`); the publisher only adds what Quartz doesn't do.

## How this repo differs from upstream

Keep upstream's files as they are, so a resync stays a plain merge of upstream `v5`. What is this repo's own:

- `scripts/publisher/` (the publisher and its tests, run with `npm run test:publisher`), `Dockerfile.publisher`, `.dockerignore`, `deploy/` and `docs/publisher-service.md`.
- `quartz.config.yaml`: upstream's `quartz.config.default.yaml` with the `explicit-publish` filter switched on.
- `package.json`: the `test:publisher` script.
- `.gitignore`: `.publisher-work`, the publisher's scratch folder.

When resyncing with upstream, compare `quartz.config.yaml` with the new `quartz.config.default.yaml` and carry over what upstream changed.
