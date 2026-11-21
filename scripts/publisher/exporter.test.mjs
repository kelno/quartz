import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { checkPermalink, createPublicationPlan, materializePublication } from "./exporter.mjs"

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "quartz-publisher-"))
  const vaultRoot = path.join(root, "vault")
  const baseContentRoot = path.join(root, "base-content")
  const destinationRoot = path.join(root, "content")
  await Promise.all([mkdir(vaultRoot), mkdir(baseContentRoot)])

  async function write(relativePath, content) {
    const target = path.join(vaultRoot, ...relativePath.split("/"))
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, content)
  }

  async function publish(options = {}) {
    const plan = await createPublicationPlan({ vaultRoot, ...options })
    await materializePublication({ plan, baseContentRoot, destinationRoot })
    return plan
  }

  function read(relativePath) {
    return readFile(path.join(destinationRoot, ...relativePath.split("/")), "utf8")
  }

  return { root, vaultRoot, baseContentRoot, destinationRoot, write, publish, read }
}

test("exports only explicitly published notes and their referenced attachments", async () => {
  const fixture = await createFixture()
  await fixture.write(
    "writing/public.md",
    `---
title: Public
publish: true
permalink: blog/public
cover: "[[media/cover.jpg]]"
---

![[media/photo.png]]
[Manual](../files/manual.pdf)
![Diagram](<../media/diagram with spaces.png>)
[[writing/private]]
`,
  )
  await fixture.write(
    "writing/private.md",
    `---
title: Private
---

This must remain private.
`,
  )
  await fixture.write(
    "writing/string-true.md",
    `---
publish: "true"
permalink: blog/string-true
---
Not a Boolean.
`,
  )
  await fixture.write(
    "writing/draft.md",
    `---
publish: true
draft: true
permalink: blog/draft
---
Still a draft.
`,
  )
  await fixture.write("media/photo.png", "photo")
  await fixture.write("media/cover.jpg", "cover")
  await fixture.write("media/diagram with spaces.png", "diagram")
  await fixture.write("files/manual.pdf", "manual")
  await fixture.write("files/unreferenced-secret.pdf", "secret")

  await writeFile(
    path.join(fixture.baseContentRoot, "index.md"),
    "---\ntitle: Home\npublish: true\n---\n",
  )

  const plan = await fixture.publish()
  assert.deepEqual(
    plan.files.map((file) => [file.relativePath, file.publishedPath]),
    [
      ["media/cover.jpg", "attachments/cover.jpg"],
      ["media/diagram with spaces.png", "attachments/diagram with spaces.png"],
      ["files/manual.pdf", "attachments/manual.pdf"],
      ["media/photo.png", "attachments/photo.png"],
      ["writing/public.md", "blog/public.md"],
    ],
  )

  assert.match(await fixture.read("index.md"), /Home/)
  const published = await fixture.read("blog/public.md")
  assert.match(published, /title: Public/)
  assert.match(published, /cover: "?attachments\/cover\.jpg"?/)
  assert.match(published, /!\[\[attachments\/photo\.png\]\]/)
  assert.match(published, /\[Manual\]\(\/attachments\/manual\.pdf\)/)
  assert.match(published, /!\[Diagram\]\(<\/attachments\/diagram with spaces\.png>\)/)
  assert.match(
    published,
    /\[\[writing\/private\]\]/,
    "a link to an unpublished note stays as written",
  )
  assert.doesNotMatch(published, /media\//)
  await assert.rejects(fixture.read("writing/private.md"))
  await assert.rejects(fixture.read("attachments/unreferenced-secret.pdf"))
})

test("publishes a note only at its permalink, never at its vault path", async () => {
  const fixture = await createFixture()
  await fixture.write(
    "Journal/2026-11-21 A thought.md",
    "---\npublish: true\npermalink: /blog/a-thought/\n---\nSee [[Design notes#How|the design]] and [[Design notes]] and [it](../Areas/Design%20notes.md).\n",
  )
  await fixture.write(
    "Areas/Design notes.md",
    "---\npublish: true\npermalink: articles/design\n---\nBody.\n",
  )

  const plan = await fixture.publish()
  assert.deepEqual(
    plan.files.map((file) => file.publishedPath),
    ["articles/design.md", "blog/a-thought.md"],
  )

  const thought = await fixture.read("blog/a-thought.md")
  assert.match(thought, /\[\[articles\/design#How\|the design\]\]/)
  assert.match(thought, /\[\[articles\/design\|Design notes\]\]/)
  assert.match(thought, /\[it\]\(\/articles\/design\)/)
  assert.doesNotMatch(thought, /Areas|Journal/)
})

test("refuses a note marked publish without a usable permalink, with a warning", async () => {
  const fixture = await createFixture()
  await fixture.write("none.md", "---\npublish: true\n---\nNo permalink.\n")
  await fixture.write("escape.md", "---\npublish: true\npermalink: ../outside\n---\n")
  await fixture.write("other.md", "---\npublish: true\npermalink: notes/other\n---\n")
  await fixture.write("bare.md", "---\npublish: true\npermalink: blog\n---\n")
  await fixture.write("good.md", "---\npublish: true\npermalink: Blog/good\n---\n")

  const plan = await createPublicationPlan({
    vaultRoot: fixture.vaultRoot,
    permalinkPrefixes: ["blog", "articles"],
  })
  assert.deepEqual(
    plan.files.map((file) => file.relativePath),
    ["good.md"],
  )
  for (const refused of ["none.md", "escape.md", "other.md", "bare.md"]) {
    assert.ok(
      plan.warnings.some((warning) =>
        warning.startsWith(`${refused}: marked publish but not published`),
      ),
      `expected a warning for ${refused}`,
    )
  }
})

test("an invalid frontmatter warning gives the position, never the note's text", async () => {
  const fixture = await createFixture()
  await fixture.write("broken.md", "---\ntitle: fine\nsummary: secret words: here\n---\nBody.\n")

  const plan = await createPublicationPlan({ vaultRoot: fixture.vaultRoot })
  assert.deepEqual(plan.warnings, [
    "broken.md: invalid YAML frontmatter at line 3, column 10; treated as unpublished",
  ])
})

test("a note with the permalink index replaces the default home page", async () => {
  const fixture = await createFixture()
  await writeFile(path.join(fixture.baseContentRoot, "index.md"), "Welcome to Quartz\n")
  await fixture.write("Somewhere/Home.md", "---\npublish: true\npermalink: Index\n---\nMy home.\n")

  const plan = await fixture.publish({ permalinkPrefixes: ["blog"] })
  assert.deepEqual(plan.warnings, [])
  assert.match(await fixture.read("index.md"), /My home\./)
  assert.doesNotMatch(await fixture.read("index.md"), /Welcome to Quartz/)
})

test("a note can't take any other path the base content holds", async () => {
  const fixture = await createFixture()
  await writeFile(path.join(fixture.baseContentRoot, "taken.md"), "Base\n")
  await fixture.write("note.md", "---\npublish: true\npermalink: taken\n---\n")

  await assert.rejects(fixture.publish(), /already taken by the base content/)
})

test("checkPermalink accepts any plain relative path when no prefixes are set", () => {
  assert.deepEqual(checkPermalink("notes/x.md"), { permalink: "notes/x" })
  assert.ok(checkPermalink("a//b").reason)
  assert.ok(checkPermalink(42).reason)
})

test("fails closed when two files would be published at the same site path", async () => {
  const fixture = await createFixture()
  await fixture.write("one.md", "---\npublish: true\npermalink: blog/same\n---\n")
  await fixture.write("two.md", "---\npublish: true\npermalink: blog/Same\n---\n")

  await assert.rejects(
    createPublicationPlan({ vaultRoot: fixture.vaultRoot }),
    /would both be published at/,
  )
})

test("fails closed when two attachments share a file name in different folders", async () => {
  const fixture = await createFixture()
  await fixture.write(
    "public.md",
    "---\npublish: true\npermalink: blog/p\n---\n\n![[one/photo.png]] ![[two/photo.png]]\n",
  )
  await fixture.write("one/photo.png", "one")
  await fixture.write("two/photo.png", "two")

  await assert.rejects(
    createPublicationPlan({ vaultRoot: fixture.vaultRoot }),
    /would both be published at attachments\/photo\.png/,
  )
})

test("fails closed when a public note transcludes an unpublished note", async () => {
  const fixture = await createFixture()
  await fixture.write("public.md", "---\npublish: true\npermalink: blog/p\n---\n\n![[private]]\n")
  await fixture.write("private.md", "---\ntitle: Private\n---\n\nSensitive text.\n")

  await assert.rejects(
    createPublicationPlan({ vaultRoot: fixture.vaultRoot }),
    /transcludes unpublished Markdown note/i,
  )
})

test("fails closed when an attachment basename is ambiguous", async () => {
  const fixture = await createFixture()
  await fixture.write("public.md", "---\npublish: true\npermalink: blog/p\n---\n\n![[photo.png]]\n")
  await fixture.write("one/photo.png", "one")
  await fixture.write("two/photo.png", "two")

  await assert.rejects(
    createPublicationPlan({ vaultRoot: fixture.vaultRoot }),
    /ambiguous reference.*photo\.png/i,
  )
})

test("does not resolve an escaping relative path by attachment basename", async () => {
  const fixture = await createFixture()
  await fixture.write(
    "nested/public.md",
    "---\npublish: true\npermalink: blog/p\n---\n\n[Secret](../../secret.pdf)\n",
  )
  await fixture.write("secret.pdf", "must not be selected")

  await assert.rejects(
    createPublicationPlan({ vaultRoot: fixture.vaultRoot }),
    /required local reference.*\.\.\/\.\.\/secret\.pdf.*could not be resolved/i,
  )
})

test("changes the publication digest when a referenced attachment changes", async () => {
  const fixture = await createFixture()
  await fixture.write("public.md", "---\npublish: true\npermalink: blog/p\n---\n\n![[photo.png]]\n")
  await fixture.write("photo.png", "first")

  const firstPlan = await createPublicationPlan({ vaultRoot: fixture.vaultRoot })
  await fixture.write("photo.png", "second")
  const secondPlan = await createPublicationPlan({ vaultRoot: fixture.vaultRoot })

  assert.notEqual(firstPlan.digest, secondPlan.digest)
})
