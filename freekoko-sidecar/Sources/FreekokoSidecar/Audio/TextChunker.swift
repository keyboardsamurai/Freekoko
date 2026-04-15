// Audio/TextChunker.swift
//
// Splits long text into chunks that fit under KokoroTTS's 510-token limit.
// Target: ~380 characters per chunk (leaves headroom vs. the 400-char
// ceiling noted in ARCHITECTURE.md §2.5).

import Foundation
import NaturalLanguage

enum TextChunker {

    /// Soft target — accumulate sentences up to this many characters, then emit.
    static let targetChunkSize = 380

    /// Hard ceiling — any single chunk must not exceed this.
    static let maxChunkSize = 400

    /// Floor for the inner fallback splitter (punctuation / whitespace search).
    private static let minFallbackSearchWindow = 50

    /// Chunk the given text into pieces each roughly ≤ `maxChunkSize` chars.
    /// Returns `[]` if the input is empty or whitespace-only.
    static func chunk(_ text: String) -> [String] {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return [] }

        // Fast path: input already fits in a single chunk.
        if trimmed.count <= maxChunkSize {
            return [trimmed]
        }

        // Tokenize into sentences using NaturalLanguage.
        let tokenizer = NLTokenizer(unit: .sentence)
        tokenizer.string = trimmed
        var sentences: [String] = []
        tokenizer.enumerateTokens(in: trimmed.startIndex..<trimmed.endIndex) { range, _ in
            let sentence = String(trimmed[range])
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if !sentence.isEmpty {
                sentences.append(sentence)
            }
            return true
        }

        // Degenerate: no sentence boundaries detected — treat the whole string
        // as one sentence and fall through to the oversize splitter below.
        if sentences.isEmpty {
            sentences = [trimmed]
        }

        var chunks: [String] = []
        var current = ""

        func flush() {
            let pending = current.trimmingCharacters(in: .whitespacesAndNewlines)
            if !pending.isEmpty {
                chunks.append(pending)
            }
            current = ""
        }

        for sentence in sentences {
            if sentence.count > maxChunkSize {
                // Sentence itself is too long — flush whatever is accumulated,
                // then split the sentence with the fallback splitter.
                flush()
                for piece in splitOversize(sentence) {
                    chunks.append(piece)
                }
                continue
            }

            let candidateLength = current.isEmpty
                ? sentence.count
                : current.count + 1 + sentence.count  // +1 for joining space

            if candidateLength > targetChunkSize, !current.isEmpty {
                flush()
                current = sentence
            } else if current.isEmpty {
                current = sentence
            } else {
                current += " " + sentence
            }
        }

        flush()
        return chunks
    }

    // MARK: - Oversize sentence fallback

    /// Split a single sentence that exceeds `maxChunkSize` characters.
    /// Looks for `,` or `;` near the ceiling first, then falls back to
    /// whitespace, then finally a hard cut at `maxChunkSize`.
    private static func splitOversize(_ sentence: String) -> [String] {
        var remaining = sentence
        var out: [String] = []

        while remaining.count > maxChunkSize {
            let cutIndex = findCutIndex(in: remaining)
            let head = remaining[..<cutIndex]
                .trimmingCharacters(in: .whitespacesAndNewlines)
            let tail = remaining[cutIndex...]
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if !head.isEmpty {
                out.append(head)
            }
            remaining = tail
            // Safety: if we made no progress, break to avoid infinite loop.
            if head.isEmpty {
                break
            }
        }

        let tail = remaining.trimmingCharacters(in: .whitespacesAndNewlines)
        if !tail.isEmpty {
            out.append(tail)
        }
        return out
    }

    /// Locate the best place to cut a too-long chunk. Priority:
    ///   1. Last `,` or `;` within [minFallbackSearchWindow, maxChunkSize]
    ///   2. Last whitespace within that window
    ///   3. Hard cut at maxChunkSize
    private static func findCutIndex(in text: String) -> String.Index {
        let ceiling = text.index(text.startIndex, offsetBy: maxChunkSize)
        let floor = text.index(text.startIndex, offsetBy: minFallbackSearchWindow)

        // Search backwards from ceiling for comma or semicolon.
        if let puncIdx = text[floor..<ceiling]
            .lastIndex(where: { $0 == "," || $0 == ";" })
        {
            // Cut just after the punctuation char so it stays with the head.
            return text.index(after: puncIdx)
        }

        // Fallback: last whitespace in the window.
        if let wsIdx = text[floor..<ceiling]
            .lastIndex(where: { $0.isWhitespace })
        {
            return wsIdx
        }

        // Hard cut.
        return ceiling
    }
}
