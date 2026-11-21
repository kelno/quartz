import assert from "node:assert/strict"
import test from "node:test"

import { createReleaseId, relativeReleaseTarget } from "./service.mjs"

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
