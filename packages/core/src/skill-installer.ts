import fs from 'node:fs'
import path from 'node:path'
import { parseSkillMd, type ParsedSkill } from './skill-parser.js'

/**
 * Represents a parsed source for skill installation
 */
export interface SkillSource {
  type: 'openclaw' | 'github'
  owner: string
  name: string
  apiUrl: string
  sourceUrl: string
}

/**
 * Result of a skill installation
 */
export interface SkillInstallResult {
  source: SkillSource
  installPath: string
  parsed: ParsedSkill
  filesDownloaded: number
}

/**
 * A file entry from the GitHub Contents API response
 */
interface GitHubContentEntry {
  name: string
  path: string
  type: 'file' | 'dir'
  download_url: string | null
  url: string
}

/**
 * Parse an input string into a SkillSource.
 * Supports:
 * - OpenClaw shorthand: "owner/name"
 * - GitHub URLs: https://github.com/owner/repo/tree/branch/path/to/skill
 */
export function parseSkillSource(input: string): SkillSource {
  input = input.trim()

  // Check if it's a GitHub URL
  const githubMatch = input.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/tree\/([^/]+)\/(.+))?$/
  )

  if (githubMatch) {
    const [, repoOwner, repoName, branch, dirPath] = githubMatch

    if (!branch || !dirPath) {
      throw new Error(
        `Invalid GitHub URL: must include branch and directory path (e.g. https://github.com/owner/repo/tree/main/path/to/skill)`
      )
    }

    // Derive skill name from the last segment of the path
    const pathParts = dirPath.replace(/\/+$/, '').split('/')
    const skillName = pathParts[pathParts.length - 1]

    return {
      type: 'github',
      owner: repoOwner,
      name: skillName,
      apiUrl: `https://api.github.com/repos/${repoOwner}/${repoName}/contents/${dirPath}?ref=${branch}`,
      sourceUrl: `https://github.com/${repoOwner}/${repoName}/tree/${branch}/${dirPath}`,
    }
  }

  // Check for OpenClaw shorthand: owner/name (no slashes beyond one)
  const shorthandMatch = input.match(/^([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)$/)
  if (shorthandMatch) {
    const [, owner, name] = shorthandMatch
    return {
      type: 'openclaw',
      owner,
      name,
      apiUrl: `https://api.github.com/repos/openclaw/skills/contents/skills/${owner}/${name}`,
      sourceUrl: `https://github.com/openclaw/skills/tree/main/skills/${owner}/${name}`,
    }
  }

  throw new Error(
    `Invalid skill source "${input}": use "owner/name" for OpenClaw or a full GitHub URL`
  )
}

/**
 * Get the base directory for skill installations
 */
function getSkillsDir(): string {
  return path.join(process.env.DATA_DIR ?? '/data', 'skills')
}

/**
 * Fetch function type — allows injection for testing
 */
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

/**
 * Download a skill directory recursively from GitHub Contents API.
 */
export async function downloadSkillDirectory(
  apiUrl: string,
  destDir: string,
  fetchFn: FetchFn = globalThis.fetch,
): Promise<number> {
  const response = await fetchFn(apiUrl, {
    headers: {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'OpenAgent-Skill-Installer',
      ...(process.env.GITHUB_TOKEN ? { 'Authorization': `token ${process.env.GITHUB_TOKEN}` } : {}),
    },
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`GitHub API error (${response.status}): ${body}`)
  }

  const entries = (await response.json()) as GitHubContentEntry[]

  if (!Array.isArray(entries)) {
    throw new Error('GitHub API did not return a directory listing. Is the path correct?')
  }

  fs.mkdirSync(destDir, { recursive: true })

  let filesDownloaded = 0

  for (const entry of entries) {
    if (entry.type === 'file' && entry.download_url) {
      // Download the file
      const fileResponse = await fetchFn(entry.download_url)
      if (!fileResponse.ok) {
        throw new Error(`Failed to download ${entry.name}: ${fileResponse.status}`)
      }

      const content = Buffer.from(await fileResponse.arrayBuffer())
      const filePath = path.join(destDir, entry.name)
      fs.writeFileSync(filePath, content)
      filesDownloaded++
    } else if (entry.type === 'dir') {
      // Recursively download subdirectory
      const subDir = path.join(destDir, entry.name)
      const subCount = await downloadSkillDirectory(entry.url, subDir, fetchFn)
      filesDownloaded += subCount
    }
  }

  return filesDownloaded
}

/**
 * Install a skill from an OpenClaw shorthand or GitHub URL.
 *
 * Downloads the skill directory, parses SKILL.md, and returns metadata.
 */
export async function installSkill(
  input: string,
  fetchFn: FetchFn = globalThis.fetch,
): Promise<SkillInstallResult> {
  const source = parseSkillSource(input)

  // Determine install path
  const installPath = path.join(getSkillsDir(), source.owner, source.name)

  // Clean existing installation if present
  if (fs.existsSync(installPath)) {
    fs.rmSync(installPath, { recursive: true, force: true })
  }

  // Download the skill directory
  const filesDownloaded = await downloadSkillDirectory(source.apiUrl, installPath, fetchFn)

  // Parse SKILL.md
  const skillMdPath = path.join(installPath, 'SKILL.md')
  if (!fs.existsSync(skillMdPath)) {
    // Clean up on failure
    fs.rmSync(installPath, { recursive: true, force: true })
    throw new Error('Downloaded directory does not contain a SKILL.md file')
  }

  const skillMdContent = fs.readFileSync(skillMdPath, 'utf-8')
  const parsed = parseSkillMd(skillMdContent)

  return {
    source,
    installPath,
    parsed,
    filesDownloaded,
  }
}
