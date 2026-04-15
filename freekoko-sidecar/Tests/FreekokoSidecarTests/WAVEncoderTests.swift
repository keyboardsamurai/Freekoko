// Tests/FreekokoSidecarTests/WAVEncoderTests.swift
//
// Verify the RIFF/WAVE PCM 16-bit encoder produces a well-formed header and
// correct little-endian Int16 samples.

import XCTest
@testable import FreekokoSidecar

final class WAVEncoderTests: XCTestCase {

    // MARK: - Helpers

    /// Read a little-endian UInt32 starting at `offset`.
    private func u32(_ data: Data, _ offset: Int) -> UInt32 {
        data.withUnsafeBytes { ptr in
            ptr.loadUnaligned(fromByteOffset: offset, as: UInt32.self).littleEndian
        }
    }

    private func u16(_ data: Data, _ offset: Int) -> UInt16 {
        data.withUnsafeBytes { ptr in
            ptr.loadUnaligned(fromByteOffset: offset, as: UInt16.self).littleEndian
        }
    }

    private func i16(_ data: Data, _ offset: Int) -> Int16 {
        data.withUnsafeBytes { ptr in
            ptr.loadUnaligned(fromByteOffset: offset, as: Int16.self).littleEndian
        }
    }

    private func ascii(_ data: Data, _ range: Range<Int>) -> String {
        String(data: data.subdata(in: range), encoding: .ascii) ?? ""
    }

    // MARK: - Header layout

    func testHeaderMagicStrings() {
        let data = WAVEncoder.encode(samples: [0.0, 0.5, -0.5], sampleRate: 24000, channels: 1)
        XCTAssertEqual(ascii(data, 0..<4), "RIFF")
        XCTAssertEqual(ascii(data, 8..<12), "WAVE")
        XCTAssertEqual(ascii(data, 12..<16), "fmt ")
        XCTAssertEqual(ascii(data, 36..<40), "data")
    }

    func testChunkSizes() {
        let samples: [Float] = Array(repeating: 0.0, count: 100)
        let data = WAVEncoder.encode(samples: samples, sampleRate: 24000, channels: 1)

        let dataSize = u32(data, 40)
        let riffSize = u32(data, 4)

        // Int16 samples → 2 bytes each
        XCTAssertEqual(dataSize, UInt32(samples.count * 2))
        // RIFF chunk size = 36 + dataSize (everything after the initial 8 bytes)
        XCTAssertEqual(riffSize, 36 + dataSize)
        // Total file size = 44-byte header + samples
        XCTAssertEqual(data.count, 44 + Int(dataSize))
    }

    func testFmtChunkFields() {
        let data = WAVEncoder.encode(samples: [0.0], sampleRate: 24000, channels: 1)

        XCTAssertEqual(u32(data, 16), 16)           // fmt chunk size
        XCTAssertEqual(u16(data, 20), 1)            // PCM
        XCTAssertEqual(u16(data, 22), 1)            // channels
        XCTAssertEqual(u32(data, 24), 24000)        // sample rate
        XCTAssertEqual(u32(data, 28), 24000 * 1 * 2) // byte rate
        XCTAssertEqual(u16(data, 32), 2)            // block align
        XCTAssertEqual(u16(data, 34), 16)           // bits per sample
    }

    // MARK: - Sample conversion

    func testSampleConversionAtUnitPeak() {
        let data = WAVEncoder.encode(samples: [1.0, -1.0], sampleRate: 24000, channels: 1)
        // Samples start at offset 44
        XCTAssertEqual(i16(data, 44), Int16.max)          // +1.0 → +32767
        XCTAssertEqual(i16(data, 46), -Int16.max)         // -1.0 → -32767
    }

    func testSampleConversionClampsOverrange() {
        let data = WAVEncoder.encode(samples: [2.0, -2.5, 0.0], sampleRate: 24000, channels: 1)
        XCTAssertEqual(i16(data, 44), Int16.max)
        XCTAssertEqual(i16(data, 46), -Int16.max)
        XCTAssertEqual(i16(data, 48), 0)
    }

    func testEmptySamplesProducesHeaderOnly() {
        let data = WAVEncoder.encode(samples: [], sampleRate: 24000, channels: 1)
        XCTAssertEqual(data.count, 44)
        XCTAssertEqual(u32(data, 40), 0)  // data size = 0
        XCTAssertEqual(u32(data, 4), 36)  // RIFF size = 36 + 0
    }

    func testSampleRateAndChannelsRespected() {
        let data = WAVEncoder.encode(samples: [0.0, 0.0], sampleRate: 48000, channels: 2)
        XCTAssertEqual(u32(data, 24), 48000)
        XCTAssertEqual(u16(data, 22), 2)
        XCTAssertEqual(u32(data, 28), 48000 * 2 * 2) // sampleRate * channels * bytesPerSample
        XCTAssertEqual(u16(data, 32), 4)             // blockAlign = channels * 2
    }
}
