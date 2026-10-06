import fs from 'node:fs/promises'
import nodePath from 'node:path'
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import { trackAgentSkillUsage } from './agent-skills.js'
import { detectImageMimeType, prepareImageForLlm } from './llm-image.js'
import { getSkillDecrypted, loadSkills } from './skill-config.js'
import { resolveWorkspacePath } from './workspace.js'

export const READ_FILE_MAX_LINES = 2000
export const READ_FILE_MAX_BYTES = 50 * 1024
const BINARY_SNIFF_BYTES = 8192

type ReadFileResult = AgentToolResult<Record<string, unknown>>

function textResult(text: string, details: Record<string, unknown>): ReadFileResult {
  return { content: [{ type: 'text', text }], details }
}

function formatKb(bytes: number): string {
  return `${Math.round(bytes / 1024)} KB`
}

/**
 * Select the requested line window and cap it at READ_FILE_MAX_LINES /
 * READ_FILE_MAX_BYTES, appending a continuation hint whenever lines remain.
 */
function selectLines(content: string, displayPath: string, offset?: number, limit?: number): string {
  const lines = content.split('\n')
  const start = offset && offset > 1 ? Math.floor(offset) - 1 : 0
  if (start >= lines.length) {
    throw new Error(`Offset ${offset} is beyond end of file (${lines.length} lines total)`)
  }
  const requestedEnd = limit !== undefined
    ? Math.min(lines.length, start + Math.max(1, Math.floor(limit)))
    : lines.length
  const lineCapEnd = Math.min(requestedEnd, start + READ_FILE_MAX_LINES)

  const selected: string[] = []
  let byteCount = 0
  for (let index = start; index < lineCapEnd; index++) {
    const lineBytes = Buffer.byteLength(lines[index], 'utf-8') + (selected.length > 0 ? 1 : 0)
    if (byteCount + lineBytes > READ_FILE_MAX_BYTES) break
    byteCount += lineBytes
    selected.push(lines[index])
  }

  if (selected.length === 0) {
    const lineNumber = start + 1
    return `[Line ${lineNumber} is ${formatKb(Buffer.byteLength(lines[start], 'utf-8'))}, exceeds the ${formatKb(READ_FILE_MAX_BYTES)} limit. Use shell: sed -n '${lineNumber}p' ${displayPath} | head -c ${READ_FILE_MAX_BYTES}]`
  }

  const end = start + selected.length
  const text = selected.join('\n')
  if (end >= lines.length) return text
  if (end < requestedEnd) {
    return `${text}\n\n[Showing lines ${start + 1}-${end} of ${lines.length}. Use offset=${end + 1} to continue.]`
  }
  return `${text}\n\n[${lines.length - end} more lines in file. Use offset=${end + 1} to continue.]`
}

async function readImage(resolved: string, buffer: Buffer, mimeType: string): Promise<ReadFileResult> {
  const prepared = await prepareImageForLlm(buffer)
  if (!prepared.ok) {
    return textResult(`Read image file [${mimeType}]\n[Image omitted: ${prepared.reason}.]`, {
      path: resolved,
      size: buffer.length,
      mimeType,
    })
  }
  const header = `Read image file [${prepared.image.mimeType}]`
  return {
    content: [
      { type: 'text', text: prepared.note ? `${header}\n${prepared.note}` : header },
      prepared.image,
    ],
    details: { path: resolved, size: buffer.length, mimeType: prepared.image.mimeType, image: true },
  }
}

function injectSkillEnv(resolved: string): string[] {
  const injectedVars: string[] = []
  try {
    const matchedSkill = loadSkills().skills.find(s => resolved.startsWith(s.path))
    const envValues = matchedSkill ? getSkillDecrypted(matchedSkill.id)?.envValues : undefined
    for (const [key, value] of Object.entries(envValues ?? {})) {
      if (value) {
        process.env[key] = value
        injectedVars.push(key)
      }
    }
  } catch {
    // Skills config not available, continue without env injection
  }
  return injectedVars
}

function readSkillFile(resolved: string, raw: string, offset?: number, limit?: number): ReadFileResult | null {
  const agentSkillMatch = resolved.match(/\/data\/skills_agent\/([^/]+)\/SKILL\.md$/)
  const installedSkillMatch = agentSkillMatch ? null : resolved.match(/\/data\/skills\/(.+)\/SKILL\.md$/)
  if (!agentSkillMatch && !installedSkillMatch) return null

  const skillDir = nodePath.dirname(resolved)
  const content = raw.replaceAll('{baseDir}', skillDir)
  const text = `Skill directory: ${skillDir}\n\n${selectLines(content, resolved, offset, limit)}`

  if (agentSkillMatch) {
    const skillName = agentSkillMatch[1]
    trackAgentSkillUsage(skillName)
    return textResult(text, { path: resolved, size: content.length, skillLoad: true, skillName, agentSkill: true })
  }

  return textResult(text, {
    path: resolved,
    size: content.length,
    skillLoad: true,
    skillName: installedSkillMatch![1],
    envVarsInjected: injectSkillEnv(resolved),
  })
}

export function createReadFileTool(): AgentTool {
  return {
    name: 'read_file',
    label: 'Read File',
    description: `Read the contents of a file at the given path. Supports text files and images (PNG, JPEG, GIF, WebP, TIFF, AVIF); images are attached so you can see them. Text output is truncated to ${READ_FILE_MAX_LINES} lines or ${READ_FILE_MAX_BYTES / 1024} KB, whichever comes first; use offset/limit to read further.`,
    parameters: Type.Object({
      path: Type.String({ description: 'Path to the file to read' }),
      offset: Type.Optional(Type.Number({ description: 'Line number to start reading from (1-indexed)' })),
      limit: Type.Optional(Type.Number({ description: 'Maximum number of lines to read' })),
    }),
    execute: async (_toolCallId, params) => {
      const { path: filePath, offset, limit } = params as { path: string; offset?: number; limit?: number }
      try {
        const resolved = resolveWorkspacePath(filePath)
        const buffer = await fs.readFile(resolved)

        const imageMimeType = detectImageMimeType(buffer)
        if (imageMimeType) return await readImage(resolved, buffer, imageMimeType)

        if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
          return textResult(
            `[Binary file (${buffer.length} bytes) cannot be displayed as text. Use shell tools (e.g. file, xxd, unzip -l) to inspect it.]`,
            { path: resolved, size: buffer.length, binary: true },
          )
        }

        const content = buffer.toString('utf-8')
        const skillResult = readSkillFile(resolved, content, offset, limit)
        if (skillResult) return skillResult

        return textResult(selectLines(content, filePath, offset, limit), { path: resolved, size: content.length })
      } catch (err: unknown) {
        return textResult(`Error reading file: ${(err as Error).message}`, { error: true })
      }
    },
  }
}
