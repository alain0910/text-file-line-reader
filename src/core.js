/**
 * Text File Line Reader — core implementation.
 *
 * Reads a file line by line as an async iterator. Each yielded value is one
 * line of text without the terminating newline. The final line is yielded
 * even if the file does not end with a newline.
 *
 * Encoding is detected from a leading Byte Order Mark when one is present;
 * otherwise the configured default encoding is used. UTF-8, UTF-16 LE, and
 * UTF-16 BE BOMs are recognised.
 *
 * The reader uses a configurable high-water mark to read the file in chunks
 * rather than loading it all into memory. Lines that span multiple chunks are
 * reassembled in a carry buffer.
 */

import { open } from 'node:fs/promises';
import { Buffer } from 'node:buffer';

const BOM_UTF8 = Buffer.from([0xEF, 0xBB, 0xBF]);
const BOM_UTF16LE = Buffer.from([0xFF, 0xFE]);
const BOM_UTF16BE = Buffer.from([0xFE, 0xFF]);

/**
 * Detect the text encoding implied by a leading Byte Order Mark.
 *
 * Returns one of 'utf8', 'utf16le', 'utf16be' when a BOM is present, or null
 * when no recognised BOM is found. The caller decides which default to use
 * when null is returned.
 *
 * We deliberately return null — rather than a default — so that the caller
 * can distinguish "no BOM, use my default" from "BOM present" without
 * second-guessing. Keeping the default a caller concern avoids an implicit
 * decision baked into detection.
 *
 * @param {Buffer} head - At least the first three bytes of the file.
 * @returns {string|null}
 */
export function detectBOMEncoding(head) {
  if (head.length >= 3 && head[0] === 0xEF && head[1] === 0xBB && head[2] === 0xBF) {
    return 'utf8';
  }
  if (head.length >= 2 && head[0] === 0xFF && head[1] === 0xFE) {
    return 'utf16le';
  }
  if (head.length >= 2 && head[0] === 0xFE && head[1] === 0xFF) {
    return 'utf16be';
  }
  return null;
}

/**
 * Find the index of the first LF byte at or after `start` in `buf`.
 *
 * Used for the fast UTF-8 / ASCII path. UTF-16 uses a different scanner
 * because a 0x0A byte can appear as either half of a non-LF code unit.
 *
 * @param {Buffer} buf
 * @param {number} start
 * @returns {number} -1 if not found.
 */
function indexOfLF(buf, start) {
  for (let i = start; i < buf.length; i++) {
    if (buf[i] === 0x0A) return i;
  }
  return -1;
}

/**
 * Find the byte offset of the first LF *code unit* in a UTF-16 view.
 *
 * `isLE` selects whether the low byte comes first. We scan two bytes at a
 * time; only a whole 16-bit unit equal to 0x000A counts as an LF. A stray
 * 0x0A byte that is the high half of some other character is ignored.
 *
 * Returns the offset of the *first* byte of the unit (the low byte for LE,
 * the high byte for BE) so that slicing the buffer at that offset leaves the
 * unit intact in the head portion.
 *
 * @param {Buffer} buf
 * @param {number} start - Must be even relative to the UTF-16 unit boundary.
 * @param {boolean} isLE
 * @returns {number} -1 if no LF unit is found.
 */
function indexOfLF_UTF16(buf, start, isLE) {
  for (let i = start; i + 1 < buf.length; i += 2) {
    const unit = isLE ? buf[i] | (buf[i + 1] << 8) : (buf[i] << 8) | buf[i + 1];
    if (unit === 0x000A) return i;
  }
  return -1;
}

/**
 * Create an async iterator over the lines of a text file.
 *
 * @param {string} path - Path to the file to read.
 * @param {Object} [options]
 * @param {number} [options.highWaterMark=16384] - Chunk size in bytes. The
 *   reader pulls at most this many bytes per read syscall. Larger values
 *   mean fewer syscalls and more memory per chunk.
 * @param {string} [options.defaultEncoding='utf8'] - Encoding used when the
 *   file has no detectable BOM. Must be one of the encodings Node's Buffer
 *   can decode incrementally without splitting multi-byte sequences across
 *   chunk boundaries, i.e. 'utf8', 'utf16le', or 'utf16be'. Latin-1 is not
 *   accepted because it has no BOM and would silently override detection.
 * @returns {AsyncIterable<string> & { close(): Promise<void> }}
 *   An async iterable yielding one line at a time. Call `close()` to release
 *   the file handle early; it is also closed automatically when iteration
 *   completes or is abandoned via `for await...of` break/return.
 */
export function createLineReader(path, options = {}) {
  const {
    highWaterMark = 16384,
    defaultEncoding = 'utf8',
  } = options;

  if (!Number.isInteger(highWaterMark) || highWaterMark <= 0) {
    throw new TypeError('highWaterMark must be a positive integer');
  }

  // Latin-1 / ascii are rejected because the implementation relies on
  // Buffer's multi-byte-aware decode to handle partial sequences across
  // chunk boundaries. Latin-1 is single-byte and has no BOM, so allowing it
  // would be a silent special case with different semantics.
  if (defaultEncoding !== 'utf8' && defaultEncoding !== 'utf16le' && defaultEncoding !== 'utf16be') {
    throw new TypeError("defaultEncoding must be 'utf8', 'utf16le', or 'utf16be'");
  }

  const reader = {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      return handle.next();
    },
    async return(value) {
      await handle.close();
      return { value, done: true };
    },
    async close() {
      await handle.close();
    },
  };

  const handle = makeHandle(path, highWaterMark, defaultEncoding);
  return reader;
}

/**
 * Resolve the canonical Node encoding label for a detected/default encoding.
 *
 * Node's Buffer.toString does not recognise 'utf16be' directly; it must be
 * passed as 'utf16le' after the caller has swapped the byte pairs. For
 * 'utf16le' and 'utf8' the label is returned unchanged.
 */
function nodeEncoding(enc) {
  if (enc === 'utf16be') return 'utf16le';
  return enc;
}

function makeHandle(path, highWaterMark, defaultEncoding) {
  let fileHandle = null;
  let initialized = false;
  let finished = false;
  let encoding = null;
  let bomOffset = 0;
  let carry = Buffer.alloc(0);
  let carryPos = 0;

  async function ensureInit() {
    if (initialized) return;
    initialized = true;
    fileHandle = await open(path, 'r');

    const head = Buffer.alloc(3);
    const { bytesRead } = await fileHandle.read(head, 0, 3, 0);
    const headSlice = head.subarray(0, bytesRead);

    const detected = detectBOMEncoding(headSlice);
    if (detected) {
      encoding = detected;
      bomOffset = detected === 'utf8' ? 3 : 2;
    } else {
      encoding = defaultEncoding;
      bomOffset = 0;
    }

    if (bytesRead > bomOffset) {
      carry = headSlice.subarray(bomOffset);
    }
  }

  /**
   * Refill `carry` with fresh bytes, preserving any unread tail from the
   * previous chunk. Returns false on EOF with no leftover bytes.
   */
  async function refill() {
    const pos = bomOffset + (carry ? carry.length : 0) - carryPos + (carryPos);
    // Simpler: compute file position of the first unread byte.
    const filePos = bomOffset + consumedBytes + (carry ? carry.length - carryPos : 0);
    const buf = Buffer.alloc(highWaterMark);
    const { bytesRead } = await fileHandle.read(buf, 0, highWaterMark, filePos);
    if (bytesRead === 0) return false;
    const chunk = buf.subarray(0, bytesRead);
    if (carryPos < carry.length) {
      carry = Buffer.concat([carry.subarray(carryPos), chunk]);
    } else {
      carry = chunk;
    }
    carryPos = 0;
    return true;
  }

  let consumedBytes = 0;

  async function next() {
    if (finished) return { value: undefined, done: true };
    await ensureInit();

    while (true) {
      const view = carry.subarray(carryPos);
      const lfIndex = encoding === 'utf16le'
        ? indexOfLF_UTF16(view, 0, true)
        : encoding === 'utf16be'
          ? indexOfLF_UTF16(view, 0, false)
          : indexOfLF(view, 0);

      if (lfIndex !== -1) {
        const lineBytes = view.subarray(0, lfIndex);
        const line = decodeLine(lineBytes, encoding);
        // Skip the LF code unit (1 byte for utf8, 2 bytes for utf16).
        const skip = encoding === 'utf8' ? 1 : 2;
        consumedBytes += lfIndex + skip;
        carryPos += lfIndex + skip;
        return { value: line, done: false };
      }

      // No LF in the current view. Try to read more.
      const gotMore = await refill();
      if (!gotMore) {
        const tail = carry.subarray(carryPos);
        if (tail.length === 0) {
          finished = true;
          await closeFile();
          return { value: undefined, done: true };
        }
        // Final line without trailing newline.
        consumedBytes += tail.length;
        carryPos = carry.length;
        const line = decodeLine(tail, encoding);
        finished = true;
        await closeFile();
        // The final line is yielded exactly once; subsequent next() returns done.
        return { value: line, done: false };
      }
    }
  }

  /**
   * Decode a line's bytes to a string, trimming a trailing CR that precedes
   * the LF (CRLF line endings). The CR belongs to the line ending, not the
   * line content, so it is stripped here rather than in the caller.
   */
  function decodeLine(bytes, enc) {
    // For UTF-16, a CR is the 16-bit unit 0x000D. Check the last two bytes.
    if (enc === 'utf16le' || enc === 'utf16be') {
      if (bytes.length >= 2) {
        const unit = enc === 'utf16le'
          ? bytes[bytes.length - 2] | (bytes[bytes.length - 1] << 8)
          : (bytes[bytes.length - 2] << 8) | bytes[bytes.length - 1];
        if (unit === 0x000D) {
          bytes = bytes.subarray(0, bytes.length - 2);
        }
      }
      if (enc === 'utf16be') {
        // Node's Buffer.toString does not accept 'utf16be'; swap bytes and
        // decode as 'utf16le'.
        const swapped = Buffer.allocUnsafe(bytes.length);
        for (let i = 0; i + 1 < bytes.length; i += 2) {
          swapped[i] = bytes[i + 1];
          swapped[i + 1] = bytes[i];
        }
        return swapped.toString('utf16le');
      }
      return bytes.toString('utf16le');
    }
    // UTF-8 / ASCII path.
    if (bytes.length >= 1 && bytes[bytes.length - 1] === 0x0D) {
      bytes = bytes.subarray(0, bytes.length - 1);
    }
    return bytes.toString('utf8');
  }

  async function closeFile() {
    if (fileHandle) {
      try {
        await fileHandle.close();
      } catch {
        // Closing twice or after an error is harmless to the caller.
      }
      fileHandle = null;
    }
  }

  async function close() {
    finished = true;
    await closeFile();
  }

  return { next, close };
}
