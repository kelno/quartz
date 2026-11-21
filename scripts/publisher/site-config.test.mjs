import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { parse as parseYaml } from "yaml"

import { assembleSiteConfig, mergeSiteConfig } from "./site-config.mjs"

const base = {
  configuration: {
    pageTitle: "Quartz",
    analytics: { provider: "plausible" },
    theme: { fontOrigin: "googleFonts", typography: { header: "A", body: "B" } },
    ignorePatterns: ["private", "templates"],
  },
  plugins: [
    { source: "one", enabled: true, options: { keep: 1, change: 1 } },
    { source: { repo: "x/two" }, enabled: false },
  ],
}

test("layers merge in order: maps key by key, other values and lists replaced whole", () => {
  const merged = mergeSiteConfig(base, [
    { name: "site", data: { configuration: { pageTitle: "Site", analytics: null } } },
    {
      name: "local",
      data: {
        configuration: {
          pageTitle: "Local",
          theme: { typography: { body: "C" } },
          ignorePatterns: ["drafts"],
        },
      },
    },
  ])

  assert.equal(merged.configuration.pageTitle, "Local")
  assert.equal(merged.configuration.analytics, null)
  assert.deepEqual(merged.configuration.theme, {
    fontOrigin: "googleFonts",
    typography: { header: "A", body: "C" },
  })
  assert.deepEqual(merged.configuration.ignorePatterns, ["drafts"])
  assert.equal(base.configuration.pageTitle, "Quartz", "the base is left unchanged")
})

test("the plugin list merges by source, and refuses a plugin the defaults don't list", () => {
  const merged = mergeSiteConfig(base, [
    { name: "site", data: { plugins: [{ source: "one", options: { change: 2 } }] } },
    { name: "local", data: { plugins: [{ source: { repo: "x/two" }, enabled: true }] } },
  ])
  assert.deepEqual(merged.plugins, [
    { source: "one", enabled: true, options: { keep: 1, change: 2 } },
    { source: { repo: "x/two" }, enabled: true },
  ])

  assert.throws(
    () => mergeSiteConfig(base, [{ name: "local", data: { plugins: [{ source: "three" }] } }]),
    /local: plugin "three" is not in quartz.config.default.yaml/,
  )
  assert.throws(
    () => mergeSiteConfig(base, [{ name: "local", data: ["not", "a", "map"] }]),
    /local: a configuration layer must be a map/,
  )
})

test("assembling reads the defaults and the layers; a missing or empty layer counts as empty", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "publisher-config-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(
    path.join(root, "quartz.config.default.yaml"),
    "configuration:\n  pageTitle: Quartz\n  baseUrl: example.org\n",
  )
  // JSON is YAML: a deployment may generate its layer as JSON.
  await writeFile(
    path.join(root, "site.json"),
    JSON.stringify({ configuration: { baseUrl: "a.b" } }),
  )
  await writeFile(path.join(root, "empty.yaml"), "")

  const text = await assembleSiteConfig({
    projectRoot: root,
    layerPaths: [
      path.join(root, "site.json"),
      path.join(root, "empty.yaml"),
      path.join(root, "absent.yaml"),
    ],
  })
  assert.deepEqual(parseYaml(text), { configuration: { pageTitle: "Quartz", baseUrl: "a.b" } })
  assert.match(text, /^# Assembled by the publisher/)
})

test("an invalid layer is reported by its position, never by its text", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "publisher-config-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(path.join(root, "quartz.config.default.yaml"), "configuration: {}\n")
  await writeFile(path.join(root, "local.yaml"), "configuration:\n  pageTitle: secret: words\n")

  await assert.rejects(
    assembleSiteConfig({ projectRoot: root, layerPaths: [path.join(root, "local.yaml")] }),
    (error) =>
      /local\.yaml: invalid YAML at line 2/.test(error.message) && !/secret/.test(error.message),
  )
})
