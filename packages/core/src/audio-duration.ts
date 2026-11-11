/**
 * Best-effort audio length from container headers, used to book speech-to-text
 * usage when the provider does not report the billed duration. Returns
 * `undefined` when the length is not stored in the file (e.g. browser WebM
 * recordings without a Duration element).
 */
export function estimateAudioDurationSeconds(audio: Buffer): number | undefined {
  const duration = readDuration(audio)
  return duration !== undefined && Number.isFinite(duration) && duration > 0 ? duration : undefined
}

function readDuration(audio: Buffer): number | undefined {
  if (audio.length < 12) return undefined
  const head4 = audio.toString('latin1', 0, 4)
  if (head4 === 'RIFF' && audio.toString('latin1', 8, 12) === 'WAVE') return wavDuration(audio)
  if (head4 === 'OggS') return oggDuration(audio)
  if (head4 === 'fLaC') return flacDuration(audio)
  if (audio.toString('latin1', 4, 8) === 'ftyp') return mp4Duration(audio)
  if (audio.readUInt32BE(0) === 0x1a45dfa3) return matroskaDuration(audio)
  return mp3Duration(audio)
}

function wavDuration(audio: Buffer): number | undefined {
  let byteRate = 0
  let offset = 12
  while (offset + 8 <= audio.length) {
    const id = audio.toString('latin1', offset, offset + 4)
    const size = audio.readUInt32LE(offset + 4)
    if (id === 'fmt ' && offset + 20 <= audio.length) byteRate = audio.readUInt32LE(offset + 16)
    if (id === 'data') {
      const dataSize = Math.min(size, audio.length - offset - 8)
      return byteRate > 0 ? dataSize / byteRate : undefined
    }
    offset += 8 + size + (size % 2)
  }
  return undefined
}

function oggDuration(audio: Buffer): number | undefined {
  const last = audio.lastIndexOf('OggS', audio.length - 4, 'latin1')
  if (last < 0 || last + 14 > audio.length) return undefined
  const granule = Number(audio.readBigInt64LE(last + 6))
  const opus = audio.indexOf('OpusHead', 0, 'latin1')
  if (opus >= 0 && opus + 12 <= audio.length) {
    const preSkip = audio.readUInt16LE(opus + 10)
    return (granule - preSkip) / 48_000
  }
  const vorbis = audio.indexOf('\x01vorbis', 0, 'latin1')
  if (vorbis >= 0 && vorbis + 16 <= audio.length) {
    const sampleRate = audio.readUInt32LE(vorbis + 12)
    return sampleRate > 0 ? granule / sampleRate : undefined
  }
  return undefined
}

function flacDuration(audio: Buffer): number | undefined {
  // STREAMINFO is always the first metadata block; its body starts at byte 8.
  if (audio.length < 26) return undefined
  const info = 8
  const sampleRate = (audio[info + 10]! << 12) | (audio[info + 11]! << 4) | (audio[info + 12]! >> 4)
  const totalSamples = (audio[info + 13]! & 0x0f) * 2 ** 32 + audio.readUInt32BE(info + 14)
  return sampleRate > 0 ? totalSamples / sampleRate : undefined
}

function mp4Duration(audio: Buffer): number | undefined {
  const mvhd = audio.indexOf('mvhd', 0, 'latin1')
  if (mvhd < 0) return undefined
  const version = audio[mvhd + 4]
  if (version === 1) {
    if (mvhd + 36 > audio.length) return undefined
    const timescale = audio.readUInt32BE(mvhd + 24)
    return timescale > 0 ? Number(audio.readBigUInt64BE(mvhd + 28)) / timescale : undefined
  }
  if (mvhd + 24 > audio.length) return undefined
  const timescale = audio.readUInt32BE(mvhd + 16)
  return timescale > 0 ? audio.readUInt32BE(mvhd + 20) / timescale : undefined
}

function matroskaDuration(file: Buffer): number | undefined {
  // Only search the header: frame data inside Clusters can contain the Duration and TimecodeScale ids by chance.
  const clusterAt = file.indexOf(Buffer.from([0x1f, 0x43, 0xb6, 0x75]))
  const audio = clusterAt >= 0 ? file.subarray(0, clusterAt) : file
  const durationId = audio.indexOf(Buffer.from([0x44, 0x89]))
  if (durationId < 0) return undefined
  const sizeByte = audio[durationId + 2]
  const value = sizeByte === 0x84 && durationId + 7 <= audio.length
    ? audio.readFloatBE(durationId + 3)
    : sizeByte === 0x88 && durationId + 11 <= audio.length
      ? audio.readDoubleBE(durationId + 3)
      : undefined
  if (value === undefined) return undefined
  const scaleId = audio.indexOf(Buffer.from([0x2a, 0xd7, 0xb1]))
  let timecodeScale = 1_000_000
  if (scaleId >= 0) {
    const length = (audio[scaleId + 3] ?? 0) & 0x0f
    if (length > 0 && length <= 6 && scaleId + 4 + length <= audio.length) timecodeScale = audio.readUIntBE(scaleId + 4, length)
  }
  return (value * timecodeScale) / 1e9
}

const MP3_BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
const MP3_BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
const MP3_SAMPLE_RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] }

/** Layer III only: Xing/Info frame count when present, otherwise the constant bitrate of the first frame. */
function mp3Duration(audio: Buffer): number | undefined {
  let offset = 0
  if (audio.toString('latin1', 0, 3) === 'ID3' && audio.length > 10) {
    offset = 10 + ((audio[6]! & 0x7f) << 21 | (audio[7]! & 0x7f) << 14 | (audio[8]! & 0x7f) << 7 | (audio[9]! & 0x7f))
  }
  for (; offset + 4 <= audio.length; offset++) {
    if (audio[offset] === 0xff && (audio[offset + 1]! & 0xe0) === 0xe0) break
  }
  if (offset + 4 > audio.length) return undefined

  const header = audio.readUInt32BE(offset)
  const versionBits = (header >> 19) & 0x3
  const layerBits = (header >> 17) & 0x3
  const bitrateIndex = (header >> 12) & 0xf
  const sampleRateIndex = (header >> 10) & 0x3
  const channelMode = (header >> 6) & 0x3
  if (layerBits !== 1 || versionBits === 1 || sampleRateIndex === 3) return undefined

  const isV1 = versionBits === 3
  const sampleRate = MP3_SAMPLE_RATES[versionBits]![sampleRateIndex]!
  const samplesPerFrame = isV1 ? 1152 : 576
  const sideInfo = isV1 ? (channelMode === 3 ? 17 : 32) : (channelMode === 3 ? 9 : 17)
  const xing = offset + 4 + sideInfo
  const tag = audio.toString('latin1', xing, xing + 4)
  if ((tag === 'Xing' || tag === 'Info') && xing + 12 <= audio.length && (audio.readUInt32BE(xing + 4) & 0x1)) {
    return (audio.readUInt32BE(xing + 8) * samplesPerFrame) / sampleRate
  }

  const bitrate = (isV1 ? MP3_BITRATES_V1_L3 : MP3_BITRATES_V2_L3)[bitrateIndex]
  return bitrate ? ((audio.length - offset) * 8) / (bitrate * 1000) : undefined
}
