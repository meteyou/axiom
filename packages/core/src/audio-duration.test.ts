import { describe, expect, it } from 'vitest'
import { estimateAudioDurationSeconds } from './audio-duration.js'

function wav(seconds: number, sampleRate = 16_000): Buffer {
  const byteRate = sampleRate * 2
  const dataSize = Math.round(seconds * byteRate)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'latin1')
  header.writeUInt32LE(36 + dataSize, 4)
  header.write('WAVE', 8, 'latin1')
  header.write('fmt ', 12, 'latin1')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'latin1')
  header.writeUInt32LE(dataSize, 40)
  return Buffer.concat([header, Buffer.alloc(dataSize)])
}

function oggPage(granule: bigint, payload: Buffer): Buffer {
  const header = Buffer.alloc(27)
  header.write('OggS', 0, 'latin1')
  header.writeBigInt64LE(granule, 6)
  return Buffer.concat([header, payload])
}

function opusOgg(seconds: number, preSkip = 312): Buffer {
  const head = Buffer.alloc(19)
  head.write('OpusHead', 0, 'latin1')
  head.writeUInt16LE(preSkip, 10)
  return Buffer.concat([
    oggPage(0n, head),
    oggPage(BigInt(Math.round(seconds * 48_000) + preSkip), Buffer.from('audio')),
  ])
}

function flac(seconds: number, sampleRate = 44_100): Buffer {
  const buffer = Buffer.alloc(42)
  buffer.write('fLaC', 0, 'latin1')
  const totalSamples = Math.round(seconds * sampleRate)
  buffer[18] = (sampleRate >> 12) & 0xff
  buffer[19] = (sampleRate >> 4) & 0xff
  buffer[20] = (sampleRate & 0x0f) << 4
  buffer[21] = Math.floor(totalSamples / 2 ** 32) & 0x0f
  buffer.writeUInt32BE(totalSamples % 2 ** 32, 22)
  return buffer
}

function m4a(seconds: number, timescale = 1000): Buffer {
  const buffer = Buffer.alloc(40)
  buffer.write('ftyp', 4, 'latin1')
  buffer.write('mvhd', 12, 'latin1')
  buffer[16] = 0
  buffer.writeUInt32BE(timescale, 28)
  buffer.writeUInt32BE(Math.round(seconds * timescale), 32)
  return buffer
}

/** MPEG-1 Layer III, 32 kbit/s, 44.1 kHz mono frame header. */
const MP3_FRAME_HEADER = Buffer.from([0xff, 0xfb, 0x10, 0xc4])

describe('estimateAudioDurationSeconds', () => {
  it('reads WAV durations from the data chunk and byte rate', () => {
    expect(estimateAudioDurationSeconds(wav(2.5))).toBeCloseTo(2.5, 3)
  })

  it('reads Ogg/Opus durations from the last granule position minus the pre-skip', () => {
    expect(estimateAudioDurationSeconds(opusOgg(7.25))).toBeCloseTo(7.25, 3)
  })

  it('reads FLAC durations from STREAMINFO', () => {
    expect(estimateAudioDurationSeconds(flac(12))).toBeCloseTo(12, 3)
  })

  it('reads MP4/M4A durations from the movie header', () => {
    expect(estimateAudioDurationSeconds(m4a(61.5))).toBeCloseTo(61.5, 3)
  })

  it('estimates constant-bitrate MP3 durations from the frame bitrate', () => {
    const audio = Buffer.concat([MP3_FRAME_HEADER, Buffer.alloc(40_000 - 4)])
    expect(estimateAudioDurationSeconds(audio)).toBeCloseTo(10, 3)
  })

  it('uses the Xing frame count of MP3 files', () => {
    const frame = Buffer.concat([MP3_FRAME_HEADER, Buffer.alloc(300)])
    const xing = 4 + 17
    frame.write('Xing', xing, 'latin1')
    frame.writeUInt32BE(0x1, xing + 4)
    frame.writeUInt32BE(1000, xing + 8)
    expect(estimateAudioDurationSeconds(frame)).toBeCloseTo((1000 * 1152) / 44_100, 3)
  })

  it('reads WebM durations when the Duration element is present', () => {
    const duration = Buffer.alloc(7)
    duration.writeUInt16BE(0x4489, 0)
    duration[2] = 0x84
    duration.writeFloatBE(4500, 3)
    const audio = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(12), duration])
    expect(estimateAudioDurationSeconds(audio)).toBeCloseTo(4.5, 3)
  })

  it('ignores Duration-like bytes in the cluster data of WebM recordings without a Duration element', () => {
    const header = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(12)])
    const cluster = Buffer.from([0x1f, 0x43, 0xb6, 0x75, 0x01, 0x02])
    const frameData = Buffer.from([0x44, 0x89, 0x84, 0x60, 0xad, 0x78, 0xec, 0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40])
    expect(estimateAudioDurationSeconds(Buffer.concat([header, cluster, frameData]))).toBeUndefined()
  })

  it('returns undefined when the length is unknown', () => {
    expect(estimateAudioDurationSeconds(Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(40)]))).toBeUndefined()
    expect(estimateAudioDurationSeconds(Buffer.from('not audio at all'))).toBeUndefined()
    expect(estimateAudioDurationSeconds(Buffer.alloc(4))).toBeUndefined()
  })
})
