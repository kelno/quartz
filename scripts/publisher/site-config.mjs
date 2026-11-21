import { readFile } from "node:fs/promises"
import path from "node:path"

import { parse as parseYaml, stringify as stringifyYaml } from "yaml"

// Quartz reads its configuration from this one file, or from the default when it is absent.
export const SITE_CONFIG_FILE = "quartz.config.yaml"
export const DEFAULT_CONFIG_FILE = "quartz.config.default.yaml"

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function pluginKey(source) {
  return JSON.stringify(source)
}

function mergeValues(base, layer) {
  if (isPlainObject(base) && isPlainObject(layer)) {
    const merged = { ...base }
    for (const [key, value] of Object.entries(layer)) {
      merged[key] = key in base ? mergeValues(base[key], value) : value
    }
    return merged
  }
  // Anything else, a list included, replaces what was there.
  return layer
}

function mergePlugins(basePlugins, layerPlugins, layerName) {
  if (!Array.isArray(layerPlugins)) {
    throw new Error(`${layerName}: plugins must be a list`)
  }
  const merged = Array.isArray(basePlugins) ? [...basePlugins] : []
  for (const entry of layerPlugins) {
    if (!isPlainObject(entry) || entry.source === undefined) {
      throw new Error(`${layerName}: each entry of plugins needs a source`)
    }
    const index = merged.findIndex(
      (existing) =>
        isPlainObject(existing) && pluginKey(existing.source) === pluginKey(entry.source),
    )
    if (index === -1) {
      // Plugins are installed when the image is built, from the default configuration's list.
      throw new Error(
        `${layerName}: plugin ${pluginKey(entry.source)} is not in ${DEFAULT_CONFIG_FILE}, so the image doesn't have it`,
      )
    }
    merged[index] = mergeValues(merged[index], entry)
  }
  return merged
}

/**
 * Merges configuration layers over a base, in order: maps key by key, the plugin list by plugin
 * `source` (a layer changes the fields it names in that plugin's entry), and any other value,
 * other lists included, replaced whole.
 */
export function mergeSiteConfig(base, layers) {
  let merged = base
  for (const { name, data } of layers) {
    if (data === null || data === undefined) {
      continue
    }
    if (!isPlainObject(data)) {
      throw new Error(`${name}: a configuration layer must be a map`)
    }
    const { plugins, ...rest } = data
    merged = mergeValues(merged, rest)
    if (plugins !== undefined) {
      merged = { ...merged, plugins: mergePlugins(merged.plugins, plugins, name) }
    }
  }
  return merged
}

async function readLayer(filePath) {
  let text
  try {
    text = await readFile(filePath, "utf8")
  } catch (error) {
    if (error.code === "ENOENT") {
      return null
    }
    throw error
  }
  try {
    return parseYaml(text)
  } catch (error) {
    // Only the position: the parser's message would copy lines of the file into the logs.
    const position = error.linePos?.[0]
    const where = position ? ` at line ${position.line}, column ${position.col}` : ""
    throw new Error(`${filePath}: invalid YAML${where}`)
  }
}

/**
 * Builds the site's Quartz configuration: Quartz's defaults from the project, then each layer
 * file in order. A layer file that doesn't exist counts as empty. Returns the YAML text to write
 * to quartz.config.yaml.
 */
export async function assembleSiteConfig({ projectRoot, layerPaths }) {
  const base = parseYaml(await readFile(path.join(projectRoot, DEFAULT_CONFIG_FILE), "utf8"))
  const layers = []
  for (const layerPath of layerPaths) {
    layers.push({ name: layerPath, data: await readLayer(layerPath) })
  }
  const merged = mergeSiteConfig(base, layers)
  return (
    `# Assembled by the publisher from ${DEFAULT_CONFIG_FILE} and ${layerPaths.join(", ")}.\n` +
    `# Change those files, not this one: it is rewritten before each build.\n` +
    stringifyYaml(merged, { lineWidth: 0 })
  )
}
