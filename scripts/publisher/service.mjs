import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import {
  access,
  lstat,
  mkdir,
  opendir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

import {
  createPublicationPlan,
  DEFAULT_IGNORED_DIRECTORIES,
  materializePublication,
  readPermalinkPrefixes,
} from "./exporter.mjs"

const RELEASE_ID_PATTERN = /^[a-f\d]{64}$/
const TEMPORARY_RELEASE_PATTERN = /^\.([a-f\d]{64})\.(\d+)\.tmp$/

function log(message) {
  console.log(`${new Date().toISOString()} ${message}`)
}

function parsePositiveInteger(value, fallback, name) {
  if (value === undefined || value === "") {
    return fallback
  }
  const parsed = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  return parsed
}

function splitCommaSeparated(value, fallback) {
  if (!value) {
    return fallback
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

export function createReleaseId({ publicationDigest, buildDigest }) {
  return createHash("sha256")
    .update(buildDigest)
    .update("\0")
    .update(publicationDigest)
    .digest("hex")
}

export function relativeReleaseTarget(releaseId) {
  if (!RELEASE_ID_PATTERN.test(releaseId)) {
    throw new Error(`Invalid release id: ${releaseId}`)
  }
  return `releases/${releaseId}`
}

async function hashRegularFile(hash, filePath, label) {
  hash.update(label)
  hash.update("\0")
  hash.update(await readFile(filePath))
  hash.update("\0")
}

async function hashTree(hash, root, label) {
  let info
  try {
    info = await lstat(root)
  } catch (error) {
    if (error.code === "ENOENT") {
      return
    }
    throw error
  }

  if (info.isSymbolicLink()) {
    throw new Error(`Build input must not be a symbolic link: ${root}`)
  }
  if (info.isFile()) {
    await hashRegularFile(hash, root, label)
    return
  }
  if (!info.isDirectory()) {
    return
  }

  const entries = []
  const directory = await opendir(root)
  for await (const entry of directory) {
    entries.push(entry.name)
  }
  entries.sort((left, right) => left.localeCompare(right, "en"))

  for (const entry of entries) {
    await hashTree(hash, path.join(root, entry), `${label}/${entry}`)
  }
}

export async function createBuildDigest({ projectRoot, baseContentRoot }) {
  const hash = createHash("sha256")
  const inputs = [
    [path.join(projectRoot, "package.json"), "package.json"],
    [path.join(projectRoot, "package-lock.json"), "package-lock.json"],
    [path.join(projectRoot, "quartz.config.yaml"), "quartz.config.yaml"],
    [path.join(projectRoot, "quartz.ts"), "quartz.ts"],
    [path.join(projectRoot, "quartz"), "quartz"],
    [path.join(projectRoot, ".quartz", "plugins", "index.ts"), ".quartz/plugins/index.ts"],
    [path.join(projectRoot, "scripts", "publisher"), "scripts/publisher"],
    [baseContentRoot, "base-content"],
  ]

  for (const [inputPath, label] of inputs) {
    await hashTree(hash, inputPath, label)
  }
  return hash.digest("hex")
}

async function runQuartzBuild({ projectRoot, outputDirectory }) {
  const bootstrap = path.join(projectRoot, "quartz", "bootstrap-cli.mjs")
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bootstrap, "build", "--output", outputDirectory], {
      cwd: projectRoot,
      stdio: "inherit",
      env: process.env,
    })

    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve()
      } else {
        reject(
          new Error(
            `Quartz build failed${signal ? ` from signal ${signal}` : ` with exit code ${code}`}`,
          ),
        )
      }
    })
  })
}

async function activateRelease(outputRoot, releaseId) {
  const currentPath = path.join(outputRoot, "current")
  const temporaryLink = path.join(outputRoot, `.current-${process.pid}`)
  // A release's modification time records when it last went live, which orders releases for
  // pruning: an older release activated again counts as the newest.
  const now = new Date()
  await utimes(path.join(outputRoot, relativeReleaseTarget(releaseId)), now, now)
  await rm(temporaryLink, { force: true })
  await symlink(relativeReleaseTarget(releaseId), temporaryLink, "dir")
  await rename(temporaryLink, currentPath)
}

async function currentReleaseId(outputRoot) {
  try {
    const target = (await readlink(path.join(outputRoot, "current"))).replaceAll("\\", "/")
    const prefix = "releases/"
    if (!target.startsWith(prefix)) {
      return null
    }
    const releaseId = target.slice(prefix.length)
    return RELEASE_ID_PATTERN.test(releaseId) ? releaseId : null
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EINVAL") {
      return null
    }
    throw error
  }
}

/**
 * Deletes old releases, keeping the `keepReleases` most recently activated ones. The release
 * `current` points to is always kept and counts among them, whatever its age, so a manual
 * rollback is never undone. Also removes the unfinished builds an interrupted run left behind.
 * Only entries named like releases are touched. Returns the names of the deleted entries.
 */
export async function pruneReleases(outputRoot, keepReleases) {
  const releasesRoot = path.join(outputRoot, "releases")
  const liveReleaseId = await currentReleaseId(outputRoot)
  const releases = []
  const deleted = []

  let directory
  try {
    directory = await opendir(releasesRoot)
  } catch (error) {
    if (error.code === "ENOENT") {
      return deleted
    }
    throw error
  }
  for await (const entry of directory) {
    if (!entry.isDirectory()) {
      continue
    }
    const temporary = entry.name.match(TEMPORARY_RELEASE_PATTERN)
    if (temporary && Number(temporary[2]) !== process.pid) {
      await rm(path.join(releasesRoot, entry.name), { recursive: true, force: true })
      deleted.push(entry.name)
    } else if (RELEASE_ID_PATTERN.test(entry.name) && entry.name !== liveReleaseId) {
      const { mtimeMs } = await lstat(path.join(releasesRoot, entry.name))
      releases.push({ name: entry.name, mtimeMs })
    }
  }

  releases.sort((left, right) => right.mtimeMs - left.mtimeMs)
  const otherReleasesKept = liveReleaseId ? keepReleases - 1 : keepReleases
  for (const release of releases.slice(Math.max(otherReleasesKept, 0))) {
    await rm(path.join(releasesRoot, release.name), { recursive: true, force: true })
    deleted.push(release.name)
  }
  return deleted
}

async function pruneReleasesSafely(config) {
  try {
    const deleted = await pruneReleases(config.outputRoot, config.keepReleases)
    if (deleted.length > 0) {
      log(`deleted ${deleted.length} old release(s); keeping the last ${config.keepReleases}`)
    }
  } catch (error) {
    // The live site is already in place; a failed cleanup is retried after the next release.
    console.warn(`${new Date().toISOString()} warning: could not delete old releases:`, error)
  }
}

async function writeState(outputRoot, state) {
  const stateDirectory = path.join(outputRoot, ".publisher")
  const statePath = path.join(stateDirectory, "state.json")
  const temporaryPath = path.join(stateDirectory, `.state-${process.pid}.json`)
  await mkdir(stateDirectory, { recursive: true })
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`)
  await rename(temporaryPath, statePath)
}

async function publishRelease({ config, plan, buildDigest, releaseId }) {
  const releasesRoot = path.join(config.outputRoot, "releases")
  const finalRelease = path.join(releasesRoot, releaseId)
  const temporaryRelease = path.join(releasesRoot, `.${releaseId}.${process.pid}.tmp`)
  const workRoot = path.join(config.projectRoot, ".publisher-work")
  const stagedContent = path.join(workRoot, `content-${releaseId}-${process.pid}`)
  const projectContent = path.join(config.projectRoot, "content")

  await mkdir(releasesRoot, { recursive: true })
  await mkdir(workRoot, { recursive: true })

  try {
    await access(finalRelease)
    log(`release ${releaseId} already exists; activating it`)
    await activateRelease(config.outputRoot, releaseId)
    await pruneReleasesSafely(config)
    return
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error
    }
  }

  await rm(stagedContent, { recursive: true, force: true })
  await rm(temporaryRelease, { recursive: true, force: true })

  try {
    await materializePublication({
      plan,
      baseContentRoot: config.baseContentRoot,
      destinationRoot: stagedContent,
    })

    await rm(projectContent, { recursive: true, force: true })
    await rename(stagedContent, projectContent)
    await runQuartzBuild({ projectRoot: config.projectRoot, outputDirectory: temporaryRelease })
    await access(path.join(temporaryRelease, "index.html"))
    await rename(temporaryRelease, finalRelease)
    await activateRelease(config.outputRoot, releaseId)
    await writeState(config.outputRoot, {
      releaseId,
      publicationDigest: plan.digest,
      buildDigest,
      publishedAt: new Date().toISOString(),
      files: plan.files.map((file) => ({ vault: file.relativePath, site: file.publishedPath })),
    })
    log(`published release ${releaseId} with ${plan.files.length} vault file(s)`)
  } finally {
    await rm(stagedContent, { recursive: true, force: true })
    await rm(temporaryRelease, { recursive: true, force: true })
  }
  await pruneReleasesSafely(config)
}

function readConfiguration(environment = process.env) {
  const projectRoot = path.resolve(environment.QUARTZ_PROJECT_DIR ?? process.cwd())
  return {
    projectRoot,
    vaultRoot: path.resolve(environment.VAULT_DIR ?? "/vault"),
    outputRoot: path.resolve(environment.OUTPUT_DIR ?? "/output"),
    baseContentRoot: path.resolve(
      environment.BASE_CONTENT_DIR ?? path.join(projectRoot, "base-content"),
    ),
    pollIntervalMs:
      parsePositiveInteger(environment.POLL_INTERVAL_SECONDS, 60, "POLL_INTERVAL_SECONDS") * 1000,
    stableScans: parsePositiveInteger(environment.STABLE_SCANS, 2, "STABLE_SCANS"),
    keepReleases: parsePositiveInteger(environment.KEEP_RELEASES, 3, "KEEP_RELEASES"),
    ignoredDirectoryNames: splitCommaSeparated(
      environment.PUBLISH_IGNORE_DIRS,
      DEFAULT_IGNORED_DIRECTORIES,
    ),
    permalinkPrefixes: readPermalinkPrefixes(environment.PUBLISH_PERMALINK_PREFIXES),
    runOnce: environment.RUN_ONCE === "true",
  }
}

function createInterruptibleDelay() {
  let wake = null
  return {
    sleep(milliseconds) {
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          wake = null
          resolve()
        }, milliseconds)
        wake = () => {
          clearTimeout(timer)
          wake = null
          resolve()
        }
      })
    },
    interrupt() {
      wake?.()
    },
  }
}

export async function runService(environment = process.env) {
  const config = readConfiguration(environment)
  const outputInfo = await stat(config.outputRoot).catch((error) => {
    if (error.code === "ENOENT") {
      return null
    }
    throw error
  })
  if (outputInfo && !outputInfo.isDirectory()) {
    throw new Error(`Output root is not a directory: ${config.outputRoot}`)
  }
  await mkdir(config.outputRoot, { recursive: true })

  const buildDigest = await createBuildDigest(config)
  await pruneReleasesSafely(config)
  const delay = createInterruptibleDelay()
  let stopping = false
  let previousCandidate = null
  let stableScanCount = 0

  const stop = (signal) => {
    log(`received ${signal}; stopping after the current operation`)
    stopping = true
    delay.interrupt()
  }
  process.once("SIGINT", () => stop("SIGINT"))
  process.once("SIGTERM", () => stop("SIGTERM"))

  log(
    `polling ${config.vaultRoot} every ${config.pollIntervalMs / 1000}s; ` +
      `requiring ${config.stableScans} stable scan(s)`,
  )

  while (!stopping) {
    try {
      const plan = await createPublicationPlan({
        vaultRoot: config.vaultRoot,
        ignoredDirectoryNames: config.ignoredDirectoryNames,
        permalinkPrefixes: config.permalinkPrefixes,
      })
      for (const warning of plan.warnings) {
        console.warn(`${new Date().toISOString()} warning: ${warning}`)
      }

      const releaseId = createReleaseId({ publicationDigest: plan.digest, buildDigest })
      if (releaseId === previousCandidate) {
        stableScanCount += 1
      } else {
        previousCandidate = releaseId
        stableScanCount = 1
      }

      const requiredScans = config.runOnce ? 1 : config.stableScans
      if (stableScanCount < requiredScans) {
        log(`candidate ${releaseId} is stable for ${stableScanCount}/${requiredScans} scan(s)`)
      } else if ((await currentReleaseId(config.outputRoot)) !== releaseId) {
        await publishRelease({ config, plan, buildDigest, releaseId })
      }
    } catch (error) {
      previousCandidate = null
      stableScanCount = 0
      console.error(`${new Date().toISOString()} publication failed:`, error)
      if (config.runOnce) {
        throw error
      }
    }

    if (config.runOnce) {
      break
    }
    await delay.sleep(config.pollIntervalMs)
  }
}

const executedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (executedDirectly) {
  runService().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
