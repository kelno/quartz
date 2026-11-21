import assert from "node:assert/strict"
import { mkdir, mkdtemp, readdir, rm, symlink, utimes } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { createReleaseId, pruneReleases, relativeReleaseTarget } from "./service.mjs"

test("release identity changes when either content or the builder changes", () => {
  const original = createReleaseId({ publicationDigest: "content-a", buildDigest: "build-a" })

  assert.equal(
    original,
    createReleaseId({ publicationDigest: "content-a", buildDigest: "build-a" }),
  )
  assert.notEqual(
    original,
    createReleaseId({ publicationDigest: "content-b", buildDigest: "build-a" }),
  )
  assert.notEqual(
    original,
    createReleaseId({ publicationDigest: "content-a", buildDigest: "build-b" }),
  )
})

test("Nginx-facing release links remain relative to the shared output directory", () => {
  const releaseId = "a".repeat(64)
  assert.equal(relativeReleaseTarget(releaseId), `releases/${releaseId}`)
  assert.throws(() => relativeReleaseTarget("../escape"), /invalid release id/i)
  assert.throws(() => relativeReleaseTarget("with/slash"), /invalid release id/i)
})

async function createOutput(t, releaseNames, { live } = {}) {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), "publisher-prune-"))
  t.after(() => rm(outputRoot, { recursive: true, force: true }))
  // The first name is the oldest release.
  for (const [index, name] of releaseNames.entries()) {
    const release = path.join(outputRoot, "releases", name)
    await mkdir(release, { recursive: true })
    const time = new Date(Date.UTC(2026, 0, 1 + index))
    await utimes(release, time, time)
  }
  if (live) {
    await symlink(`releases/${live}`, path.join(outputRoot, "current"), "dir")
  }
  return outputRoot
}

const listReleases = async (outputRoot) => (await readdir(path.join(outputRoot, "releases"))).sort()

test("old releases are deleted, keeping the most recently activated ones", async (t) => {
  const [a, b, c, d, e] = ["a", "b", "c", "d", "e"].map((letter) => letter.repeat(64))
  const outputRoot = await createOutput(t, [a, b, c, d, e], { live: e })

  assert.deepEqual((await pruneReleases(outputRoot, 3)).sort(), [a, b])
  assert.deepEqual(await listReleases(outputRoot), [c, d, e])
})

test("the live release is always kept and counts among the kept releases", async (t) => {
  const [a, b, c, d] = ["a", "b", "c", "d"].map((letter) => letter.repeat(64))
  // A rollback made by hand: current points to the oldest release.
  const outputRoot = await createOutput(t, [a, b, c, d], { live: a })

  await pruneReleases(outputRoot, 2)
  assert.deepEqual(await listReleases(outputRoot), [a, d])

  await pruneReleases(outputRoot, 1)
  assert.deepEqual(await listReleases(outputRoot), [a])
})

test("pruning removes unfinished builds but leaves unknown entries alone", async (t) => {
  const release = "a".repeat(64)
  const unfinished = `.${"b".repeat(64)}.999999.tmp`
  const outputRoot = await createOutput(t, [release, unfinished, "kept-by-hand"], {
    live: release,
  })

  assert.deepEqual(await pruneReleases(outputRoot, 1), [unfinished])
  assert.deepEqual(await listReleases(outputRoot), [release, "kept-by-hand"])
})

test("pruning an output without releases does nothing", async (t) => {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), "publisher-prune-"))
  t.after(() => rm(outputRoot, { recursive: true, force: true }))
  assert.deepEqual(await pruneReleases(outputRoot, 3), [])
})
