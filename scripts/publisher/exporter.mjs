import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  opendir,
  readFile,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises"
import path from "node:path"

import remarkParse from "remark-parse"
import { unified } from "unified"
import { visit } from "unist-util-visit"
import { parseDocument, parse as parseYaml } from "yaml"

export const DEFAULT_IGNORED_DIRECTORIES = [".git", ".obsidian", ".trash"]

// Every attachment a published note uses is published under this one folder, by file name, so
// the site never shows the folders the attachments live in inside the vault.
export const ATTACHMENTS_FOLDER = "attachments"

const FRONTMATTER_PATTERN = /^---[\t ]*\r?\n([\s\S]*?)\r?\n---[\t ]*(?:\r?\n|$)/
const WIKILINK_PATTERN = /(!?)\[\[([^\]]+)\]\]/g
const HTML_REFERENCE_PATTERN = /(?:src|href)=["']([^"']+)["']/gi
const FRONTMATTER_ASSET_FIELDS = ["cover", "image", "socialImage"]

function toPosixPath(value) {
  return value.split(path.sep).join("/")
}

function foldPath(value) {
  return value.toLocaleLowerCase("en-US")
}

function isMarkdown(relativePath) {
  return path.posix.extname(relativePath).toLocaleLowerCase("en-US") === ".md"
}

function isExternalReference(value) {
  return /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(value)
}

function isInsideRoot(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..")
}

async function hashFile(filePath) {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk)
  }
  return hash.digest("hex")
}

function hashBuffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex")
}

async function walkVault(root, ignoredDirectoryNames) {
  const files = []
  const ignored = new Set(ignoredDirectoryNames.map(foldPath))

  async function walk(directory, relativeDirectory = "") {
    const handle = await opendir(directory)
    for await (const entry of handle) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
      const absolutePath = path.join(directory, entry.name)

      if (entry.isSymbolicLink()) {
        continue
      }

      if (entry.isDirectory()) {
        if (!ignored.has(foldPath(entry.name))) {
          await walk(absolutePath, relativePath)
        }
        continue
      }

      if (entry.isFile()) {
        files.push({ relativePath, sourcePath: absolutePath })
      }
    }
  }

  await walk(root)
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en"))
  return files
}

function parseFrontmatter(relativePath, source) {
  const match = source.match(FRONTMATTER_PATTERN)
  if (!match) {
    return { data: {}, frontmatterYaml: null, body: source, warning: null }
  }

  const body = source.slice(match[0].length)
  try {
    const parsed = parseYaml(match[1])
    const data = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}
    return { data, frontmatterYaml: match[1], body, warning: null }
  } catch (error) {
    return {
      data: {},
      frontmatterYaml: null,
      body,
      warning: `${relativePath}: invalid YAML frontmatter; treated as unpublished (${error.message})`,
    }
  }
}

function splitPrefixes(value) {
  return value
    .split(",")
    .map((item) => item.trim().replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
}

/**
 * The site path a note is published at comes only from its `permalink`, never from where the
 * note sits in the vault, so publishing reveals nothing of the vault's layout. A note without a
 * usable permalink is refused (left unpublished, with a warning) rather than published at a
 * guessed path. With `permalinkPrefixes`, the permalink's first folder must be one of them: that
 * folder is the part of the site the note belongs to.
 */
export function checkPermalink(value, permalinkPrefixes = []) {
  if (value === undefined || value === null || value === "") {
    return { reason: "no permalink" }
  }
  if (typeof value !== "string") {
    return { reason: "permalink is not text" }
  }

  const permalink = value
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.(?:md|html)$/i, "")
  const segments = permalink.split("/")
  if (
    permalink === "" ||
    permalink.includes("\\") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    return { reason: `permalink "${value}" is not a plain relative path` }
  }

  if (permalinkPrefixes.length > 0) {
    const prefixes = permalinkPrefixes.map(foldPath)
    if (segments.length < 2 || !prefixes.includes(foldPath(segments[0]))) {
      return {
        reason: `permalink "${value}" must start with one of ${permalinkPrefixes
          .map((prefix) => `${prefix}/`)
          .join(", ")} followed by a page name`,
      }
    }
  }

  return { permalink }
}

export function readPermalinkPrefixes(value) {
  return value ? splitPrefixes(value) : []
}

function addFrontmatterReferences(references, data) {
  for (const field of FRONTMATTER_ASSET_FIELDS) {
    const value = data[field]
    const values = Array.isArray(value) ? value : [value]
    values.forEach((target, position) => {
      if (typeof target === "string" && target.trim() !== "") {
        references.push({
          target,
          embed: true,
          syntax: "frontmatter",
          field,
          position: Array.isArray(value) ? position : null,
        })
      }
    })
  }
}

// Each body reference keeps where it sits in the body (`start`, `end`), so the published copy
// can point it at the page or attachment's site path instead of its vault path.
function extractReferences(body, data) {
  const references = []
  const tree = unified().use(remarkParse).parse(body)

  visit(tree, (node) => {
    if ((node.type === "link" || node.type === "image") && typeof node.url === "string") {
      references.push({
        target: node.url,
        embed: node.type === "image",
        syntax: "markdown",
        start: node.position.start.offset,
        end: node.position.end.offset,
      })
    }
  })

  for (const match of body.matchAll(WIKILINK_PATTERN)) {
    references.push({
      target: match[2].split("|", 1)[0],
      embed: match[1] === "!",
      syntax: "wikilink",
      start: match.index,
      end: match.index + match[0].length,
    })
  }

  for (const match of body.matchAll(HTML_REFERENCE_PATTERN)) {
    const start = match.index + match[0].indexOf(match[1], match[0].indexOf("="))
    references.push({
      target: match[1],
      embed: true,
      syntax: "html",
      start,
      end: start + match[1].length,
    })
  }

  addFrontmatterReferences(references, data)
  return references
}

function fragmentOf(rawTarget) {
  const index = rawTarget.indexOf("#")
  return index >= 0 ? rawTarget.slice(index) : ""
}

function rewriteWikilink(original, sitePath, isNote) {
  const embed = original.startsWith("!") ? "!" : ""
  const inner = original.slice(embed.length + 2, -2)
  const pipe = inner.indexOf("|")
  const target = pipe >= 0 ? inner.slice(0, pipe) : inner
  const label = pipe >= 0 ? inner.slice(pipe + 1) : null
  // A note link keeps the text the reader saw in the vault; an attachment keeps its size option.
  const shown = label ?? (isNote && !embed ? target : null)
  return `${embed}[[${sitePath}${fragmentOf(target)}${shown === null ? "" : `|${shown}`}]]`
}

function rewriteMarkdownLink(original, sitePath, note) {
  if (!original.endsWith(")")) {
    throw new Error(
      `${note}: reference-style Markdown link "${original}" can't be pointed at its published path; write it as an inline link or a wikilink`,
    )
  }
  const open = original.lastIndexOf("](")
  const inside = original.slice(open + 2, -1)
  const leading = inside.match(/^\s*/)[0]
  const rest = inside.slice(leading.length)
  const destination = rest.startsWith("<")
    ? rest.slice(0, rest.indexOf(">") + 1)
    : rest.split(/\s/, 1)[0]
  const bare = destination.startsWith("<") ? destination.slice(1, -1) : destination
  const replacement = `/${sitePath}${fragmentOf(bare)}`
  const formatted = /[\s()<>]/.test(replacement) ? `<${replacement}>` : replacement
  return `${original.slice(0, open + 2)}${leading}${formatted}${rest.slice(destination.length)})`
}

/**
 * Builds the text of a note's published copy: the same note, with every reference to a
 * published page or attachment pointed at its site path. References to unpublished notes are
 * left as written: the reader then sees a link that leads nowhere, an honest sign of a
 * publishing mistake rather than a gap covered up.
 */
function rewriteNote(note, rewrites) {
  let body = note.body
  const bodyRewrites = rewrites
    .filter(({ reference }) => reference.syntax !== "frontmatter")
    .sort((left, right) => right.reference.start - left.reference.start)
  for (const { reference, sitePath, isNote } of bodyRewrites) {
    const original = body.slice(reference.start, reference.end)
    let replacement
    if (reference.syntax === "wikilink") {
      replacement = rewriteWikilink(original, sitePath, isNote)
    } else if (reference.syntax === "markdown") {
      replacement = rewriteMarkdownLink(original, sitePath, note.relativePath)
    } else {
      replacement = encodeURI(`/${sitePath}`)
    }
    body = body.slice(0, reference.start) + replacement + body.slice(reference.end)
  }

  const frontmatterRewrites = rewrites.filter(({ reference }) => reference.syntax === "frontmatter")
  if (note.frontmatterYaml === null) {
    return body
  }
  if (frontmatterRewrites.length === 0) {
    return note.source.slice(0, note.source.length - note.body.length) + body
  }

  const document = parseDocument(note.frontmatterYaml)
  for (const { reference, sitePath } of frontmatterRewrites) {
    const pathInDocument =
      reference.position === null ? [reference.field] : [reference.field, reference.position]
    document.setIn(pathInDocument, sitePath)
  }
  return `---\n${document.toString()}---\n${body}`
}

function cleanReferenceTarget(rawTarget) {
  let target = rawTarget.trim()
  if (target.startsWith("![[") && target.endsWith("]]")) {
    target = target.slice(3, -2).split("|", 1)[0]
  } else if (target.startsWith("[[") && target.endsWith("]]")) {
    target = target.slice(2, -2).split("|", 1)[0]
  }
  if (target.startsWith("<") && target.endsWith(">")) {
    target = target.slice(1, -1)
  }

  if (target === "" || target.startsWith("#") || isExternalReference(target)) {
    return null
  }

  const fragmentIndex = target.indexOf("#")
  if (fragmentIndex >= 0) {
    target = target.slice(0, fragmentIndex)
  }

  const queryIndex = target.indexOf("?")
  if (queryIndex >= 0) {
    target = target.slice(0, queryIndex)
  }

  try {
    target = decodeURIComponent(target)
  } catch {
    // Keep the literal path. Resolution will fail closed for required assets.
  }

  return target.replaceAll("\\", "/").trim()
}

function createVaultIndex(files) {
  const byPath = new Map()
  const byBasename = new Map()

  for (const file of files) {
    byPath.set(foldPath(file.relativePath), file)
    const basename = foldPath(path.posix.basename(file.relativePath))
    const matches = byBasename.get(basename) ?? []
    matches.push(file)
    byBasename.set(basename, matches)
  }

  return { byPath, byBasename }
}

function candidatePaths(target, sourceRelativePath) {
  const sourceDirectory = path.posix.dirname(sourceRelativePath)
  const withoutLeadingSlash = target.replace(/^\/+/, "")
  const rawCandidates = target.startsWith("/")
    ? [withoutLeadingSlash]
    : [path.posix.join(sourceDirectory, target), withoutLeadingSlash]
  const candidates = []

  for (const candidate of rawCandidates) {
    const normalized = path.posix.normalize(candidate)
    if (normalized === ".." || normalized.startsWith("../")) {
      continue
    }
    candidates.push(normalized)
    if (path.posix.extname(normalized) === "") {
      candidates.push(`${normalized}.md`)
    }
  }

  return [...new Set(candidates)]
}

function resolveReference(reference, sourceRelativePath, index) {
  const target = cleanReferenceTarget(reference.target)
  if (!target) {
    return { target: null, file: null }
  }

  for (const candidate of candidatePaths(target, sourceRelativePath)) {
    const match = index.byPath.get(foldPath(candidate))
    if (match) {
      return { target, file: match }
    }
  }

  if (target.includes("/")) {
    return { target, file: null }
  }

  const basenameCandidates = [path.posix.basename(target)]
  if (path.posix.extname(target) === "") {
    basenameCandidates.push(`${path.posix.basename(target)}.md`)
  }

  const basenameMatches = new Map()
  for (const basename of basenameCandidates) {
    for (const match of index.byBasename.get(foldPath(basename)) ?? []) {
      basenameMatches.set(match.relativePath, match)
    }
  }

  if (basenameMatches.size > 1) {
    throw new Error(
      `${sourceRelativePath}: ambiguous reference "${target}" matches ${[
        ...basenameMatches.keys(),
      ].join(", ")}`,
    )
  }

  return { target, file: basenameMatches.values().next().value ?? null }
}

function looksLikeAttachment(target) {
  return target !== null && path.posix.extname(target) !== ""
}

function publicationDigest(files) {
  const hash = createHash("sha256")
  for (const file of files) {
    hash.update(file.publishedPath)
    hash.update("\0")
    hash.update(file.digest)
    hash.update("\0")
    hash.update(file.content === undefined ? String(file.size) : hashBuffer(file.content))
    hash.update("\0")
  }
  return hash.digest("hex")
}

function attachmentSitePath(relativePath) {
  return `${ATTACHMENTS_FOLDER}/${path.posix.basename(relativePath)}`
}

export async function createPublicationPlan({
  vaultRoot,
  ignoredDirectoryNames = DEFAULT_IGNORED_DIRECTORIES,
  permalinkPrefixes = [],
}) {
  const resolvedVaultRoot = path.resolve(vaultRoot)
  const rootInfo = await stat(resolvedVaultRoot)
  if (!rootInfo.isDirectory()) {
    throw new Error(`Vault root is not a directory: ${resolvedVaultRoot}`)
  }

  const sourceFiles = await walkVault(resolvedVaultRoot, ignoredDirectoryNames)
  const index = createVaultIndex(sourceFiles)
  const notes = new Map()
  const warnings = []

  for (const file of sourceFiles.filter((candidate) => isMarkdown(candidate.relativePath))) {
    const buffer = await readFile(file.sourcePath)
    const source = buffer.toString("utf8")
    const parsed = parseFrontmatter(file.relativePath, source)
    if (parsed.warning) {
      warnings.push(parsed.warning)
    }

    let sitePath = null
    if (parsed.data.publish === true && parsed.data.draft !== true) {
      const checked = checkPermalink(parsed.data.permalink, permalinkPrefixes)
      if (checked.reason) {
        warnings.push(`${file.relativePath}: marked publish but not published: ${checked.reason}`)
      } else {
        sitePath = checked.permalink
      }
    }

    notes.set(file.relativePath, {
      ...file,
      ...parsed,
      source,
      size: buffer.byteLength,
      digest: hashBuffer(buffer),
      sitePath,
    })
  }

  const selectedNotes = [...notes.values()].filter((note) => note.sitePath !== null)
  const selectedFiles = new Map()

  for (const note of selectedNotes) {
    const rewrites = []
    for (const reference of extractReferences(note.body, note.data)) {
      const resolved = resolveReference(reference, note.relativePath, index)
      if (!resolved.target) {
        continue
      }

      if (!resolved.file) {
        if (reference.embed || looksLikeAttachment(resolved.target)) {
          throw new Error(
            `${note.relativePath}: required local reference "${resolved.target}" could not be resolved`,
          )
        }
        warnings.push(`${note.relativePath}: unresolved note link "${resolved.target}"`)
        continue
      }

      if (isMarkdown(resolved.file.relativePath)) {
        const linked = notes.get(resolved.file.relativePath)
        if (linked.sitePath === null) {
          if (reference.embed) {
            throw new Error(
              `${note.relativePath}: transcludes unpublished Markdown note "${resolved.file.relativePath}"`,
            )
          }
          warnings.push(
            `${note.relativePath}: links to unpublished note "${resolved.file.relativePath}"`,
          )
          continue
        }
        rewrites.push({ reference, sitePath: linked.sitePath, isNote: true })
        continue
      }

      const sitePath = attachmentSitePath(resolved.file.relativePath)
      rewrites.push({ reference, sitePath, isNote: false })
      if (!selectedFiles.has(resolved.file.relativePath)) {
        const fileInfo = await stat(resolved.file.sourcePath)
        selectedFiles.set(resolved.file.relativePath, {
          relativePath: resolved.file.relativePath,
          publishedPath: sitePath,
          sourcePath: resolved.file.sourcePath,
          size: fileInfo.size,
          digest: await hashFile(resolved.file.sourcePath),
        })
      }
    }

    selectedFiles.set(note.relativePath, {
      relativePath: note.relativePath,
      publishedPath: `${note.sitePath}.md`,
      sourcePath: note.sourcePath,
      size: note.size,
      digest: note.digest,
      content: Buffer.from(rewriteNote(note, rewrites), "utf8"),
    })
  }

  const files = [...selectedFiles.values()].sort((left, right) =>
    left.publishedPath.localeCompare(right.publishedPath, "en"),
  )

  // Two vault files landing on the same site path would silently hide one of them.
  const byPublishedPath = new Map()
  for (const file of files) {
    const key = foldPath(file.publishedPath)
    const other = byPublishedPath.get(key)
    if (other) {
      throw new Error(
        `"${other.relativePath}" and "${file.relativePath}" would both be published at ${file.publishedPath}`,
      )
    }
    byPublishedPath.set(key, file)
  }

  return {
    vaultRoot: resolvedVaultRoot,
    files,
    warnings,
    digest: publicationDigest(files),
  }
}

export async function materializePublication({ plan, baseContentRoot, destinationRoot }) {
  const resolvedDestination = path.resolve(destinationRoot)
  await mkdir(resolvedDestination)

  if (baseContentRoot) {
    const resolvedBase = path.resolve(baseContentRoot)
    await cp(resolvedBase, resolvedDestination, { recursive: true, force: false })
  }

  for (const file of plan.files) {
    const target = path.resolve(resolvedDestination, ...file.publishedPath.split("/"))
    if (!isInsideRoot(resolvedDestination, target)) {
      throw new Error(`Refusing to write outside publication root: ${file.publishedPath}`)
    }
    const existing = await lstat(target).catch((error) => {
      if (error.code === "ENOENT") {
        return null
      }
      throw error
    })
    if (existing) {
      throw new Error(
        `${file.relativePath}: ${file.publishedPath} is already taken by the base content`,
      )
    }

    await mkdir(path.dirname(target), { recursive: true })
    if (file.content === undefined) {
      await copyFile(file.sourcePath, target)
      if ((await hashFile(target)) !== file.digest) {
        throw new Error(`${file.relativePath}: source changed while creating publication snapshot`)
      }
    } else {
      if ((await hashFile(file.sourcePath)) !== file.digest) {
        throw new Error(`${file.relativePath}: source changed while creating publication snapshot`)
      }
      await writeFile(target, file.content)
    }

    const sourceInfo = await lstat(file.sourcePath)
    await utimes(target, sourceInfo.atime, sourceInfo.mtime)
  }
}
