// Tests/FreekokoSidecarTests/TextChunkerTests.swift
//
// Boundary cases for the text chunker.

import XCTest
@testable import FreekokoSidecar

final class TextChunkerTests: XCTestCase {

    func testEmptyStringReturnsNoChunks() {
        XCTAssertTrue(TextChunker.chunk("").isEmpty)
        XCTAssertTrue(TextChunker.chunk("   \n\t ").isEmpty)
    }

    func testShortSentenceReturnsSingleChunk() {
        let text = "Hello, world."
        let chunks = TextChunker.chunk(text)
        XCTAssertEqual(chunks, [text])
    }

    func testMediumParagraphUnderCeilingReturnsSingleChunk() {
        // 300 chars, one sentence.
        let text = String(repeating: "a ", count: 150).trimmingCharacters(in: .whitespaces) + "."
        XCTAssertLessThanOrEqual(text.count, TextChunker.maxChunkSize)
        let chunks = TextChunker.chunk(text)
        XCTAssertEqual(chunks.count, 1)
    }

    func testLongInputProducesMultipleChunksAllUnderCeiling() {
        // Build a long paragraph of normal sentences, total ~8000 chars.
        let sentence = "The quick brown fox jumps over the lazy dog near the old oak tree. "
        var text = ""
        while text.count < 8000 {
            text += sentence
        }
        text = String(text.prefix(8000))

        let chunks = TextChunker.chunk(text)
        XCTAssertGreaterThan(chunks.count, 1)
        for (i, chunk) in chunks.enumerated() {
            XCTAssertLessThanOrEqual(
                chunk.count,
                TextChunker.maxChunkSize,
                "Chunk \(i) exceeds max size: \(chunk.count)"
            )
            XCTAssertFalse(chunk.isEmpty, "Chunk \(i) is empty")
        }
    }

    func testSingleOversizeSentenceSplitsOnPunctuation() {
        // 600-char sentence with commas — should split on commas.
        let parts = Array(repeating: "alpha beta gamma delta epsilon zeta", count: 15)
        let text = parts.joined(separator: ", ") + "."
        XCTAssertGreaterThan(text.count, TextChunker.maxChunkSize)

        let chunks = TextChunker.chunk(text)
        XCTAssertGreaterThan(chunks.count, 1)
        for chunk in chunks {
            XCTAssertLessThanOrEqual(chunk.count, TextChunker.maxChunkSize)
        }
    }

    func testUrlHeavyTextStaysWithinChunks() {
        // URLs shouldn't be broken mid-URL when they fit within one chunk.
        let text = """
        Check out https://example.com/very/long/path/to/resource for details. \
        Also see https://another.example.org/documentation/page?query=value for more info. \
        Finally, review https://third.site.com/guide for the complete picture.
        """
        let chunks = TextChunker.chunk(text)
        XCTAssertFalse(chunks.isEmpty)
        // Each URL should appear intact in at least one chunk.
        let urls = [
            "https://example.com/very/long/path/to/resource",
            "https://another.example.org/documentation/page?query=value",
            "https://third.site.com/guide",
        ]
        for url in urls {
            let found = chunks.contains { $0.contains(url) }
            XCTAssertTrue(found, "URL \(url) was split across chunks")
        }
    }

    func testEightThousandCharInputReturnsNonEmptyChunks() {
        let text = String(repeating: "This is a sample sentence. ", count: 350)
            .prefix(8000)
        let chunks = TextChunker.chunk(String(text))
        XCTAssertGreaterThan(chunks.count, 1)
        for chunk in chunks {
            XCTAssertFalse(chunk.isEmpty)
            XCTAssertLessThanOrEqual(chunk.count, TextChunker.maxChunkSize)
        }
    }
}
