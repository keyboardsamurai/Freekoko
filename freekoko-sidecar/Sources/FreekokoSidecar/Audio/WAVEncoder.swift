// Audio/WAVEncoder.swift
//
// Pure-Swift RIFF/WAVE PCM 16-bit encoder. Zero AVFoundation dependency.
// Mirrors the encoding pattern from upstream KokoroVoice/VoiceManager.swift.

import Foundation

enum WAVEncoder {

    /// Encode Float32 samples (range [-1.0, 1.0]) into a WAV `Data` buffer.
    ///
    /// Header layout (44 bytes):
    ///   0  "RIFF"              4
    ///   4  file size - 8       4  UInt32 LE
    ///   8  "WAVE"              4
    ///  12  "fmt "              4
    ///  16  fmt chunk size=16   4  UInt32 LE
    ///  20  audio format=1      2  UInt16 LE (PCM)
    ///  22  numChannels         2  UInt16 LE
    ///  24  sampleRate          4  UInt32 LE
    ///  28  byteRate            4  UInt32 LE
    ///  32  blockAlign          2  UInt16 LE
    ///  34  bitsPerSample=16    2  UInt16 LE
    ///  36  "data"              4
    ///  40  data size           4  UInt32 LE
    ///  44  samples ...         N
    static func encode(
        samples: [Float],
        sampleRate: Int = 24000,
        channels: Int = 1
    ) -> Data {
        let numChannels = UInt16(channels)
        let bitsPerSample: UInt16 = 16
        let bytesPerSample = Int(bitsPerSample / 8)
        let byteRate = UInt32(sampleRate) * UInt32(numChannels) * UInt32(bytesPerSample)
        let blockAlign = UInt16(Int(numChannels) * bytesPerSample)
        let dataSize = UInt32(samples.count * bytesPerSample)
        let fileSize = UInt32(36) + dataSize  // file size minus 8-byte RIFF prefix

        var data = Data()
        data.reserveCapacity(44 + Int(dataSize))

        // RIFF header
        data.append(contentsOf: "RIFF".utf8)
        appendLE(&data, fileSize)
        data.append(contentsOf: "WAVE".utf8)

        // fmt subchunk
        data.append(contentsOf: "fmt ".utf8)
        appendLE(&data, UInt32(16))           // PCM fmt chunk size
        appendLE(&data, UInt16(1))            // audio format: 1 = PCM
        appendLE(&data, numChannels)
        appendLE(&data, UInt32(sampleRate))
        appendLE(&data, byteRate)
        appendLE(&data, blockAlign)
        appendLE(&data, bitsPerSample)

        // data subchunk
        data.append(contentsOf: "data".utf8)
        appendLE(&data, dataSize)

        // Samples: Float -> clamped Int16, little-endian.
        // Multiply by Int16.max = 32767 (not 32768) so that +1.0 maps cleanly
        // to +32767 and -1.0 maps to -32767.
        let scale = Float(Int16.max)
        for sample in samples {
            let clamped = max(-1.0, min(1.0, sample))
            let value = Int16(clamped * scale)
            appendLE(&data, value)
        }

        return data
    }

    // MARK: - Little-endian helpers

    private static func appendLE(_ data: inout Data, _ value: UInt16) {
        var le = value.littleEndian
        withUnsafeBytes(of: &le) { data.append(contentsOf: $0) }
    }

    private static func appendLE(_ data: inout Data, _ value: UInt32) {
        var le = value.littleEndian
        withUnsafeBytes(of: &le) { data.append(contentsOf: $0) }
    }

    private static func appendLE(_ data: inout Data, _ value: Int16) {
        var le = value.littleEndian
        withUnsafeBytes(of: &le) { data.append(contentsOf: $0) }
    }
}
