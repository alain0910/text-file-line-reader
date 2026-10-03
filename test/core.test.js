import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLineReader, detectBOMEncoding } from '../src/index.js';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 'line-reader-'));
}

async function collect(iter) {
  const out = [];
  for await (const line of iter) {
    out.push(line);
  }
  return out;
}

function swapUTF16LEtoBE(buf) {
  const out = Buffer.allocUnsafe(buf.length);
  for (let i = 0; i + 1 < buf.length; i += 2) {
    out[i] = buf[i + 1];
    out[i + 1] = buf[i];
  }
  return out;
}

test('reads a simple UTF-8 file line by line', async () => {
  const dir = makeTempDir();
  try {
    const path = join(dir, 'simple.txt');
    writeFileSync(path, 'alpha\nbravo\ncharlie\n');
    const lines = await collect(createLineReader(path));
    assert.deepEqual(lines, ['alpha', 'bravo', 'charlie']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('yields the final line when the file has no trailing newline', async () => {
  const dir = makeTempDir();
  try {
    const path = join(dir, 'no-trailing.txt');
    writeFileSync(path, 'one\ntwo\nthree');
    const lines = await collect(createLineReader(path));
    assert.deepEqual(lines, ['one', 'two', 'three']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handles CRLF line endings by stripping the CR', async () => {
  const dir = makeTempDir();
  try {
    const path = join(dir, 'crlf.txt');
    writeFileSync(path, Buffer.from('alpha\r\nbravo\r\ncharlie\r\n'));
    const lines = await collect(createLineReader(path));
    assert.deepEqual(lines, ['alpha', 'bravo', 'charlie']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handles a final CRLF line without a following newline', async () => {
  const dir = makeTempDir();
  try {
    const path = join(dir, 'crlf-no-trailing.txt');
    writeFileSync(path, Buffer.from('one\r\ntwo\r\nthree'));
    const lines = await collect(createLineReader(path));
    assert.deepEqual(lines, ['one', 'two', 'three']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('yields an empty string for blank lines', async () => {
  const dir = makeTempDir();
  try {
    const path = join(dir, 'blanks.txt');
    writeFileSync(path, 'a\n\n\nb\n');
    const lines = await collect(createLineReader(path));
    assert.deepEqual(lines, ['a', '', '', 'b']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reads an empty file as zero lines', async () => {
  const dir = makeTempDir();
  try {
    const path = join(dir, 'empty.txt');
    writeFileSync(path, '');
    const lines = await collect(createLineReader(path));
    assert.deepEqual(lines, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reads a file whose only content is a single newline', async () => {
  const dir = makeTempDir();
  try {
    const path = join(dir, 'just-newline.txt');
    writeFileSync(path, '\n');
    const lines = await collect(createLineReader(path));
    assert.deepEqual(lines, ['']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reassembles lines that span multiple chunks', async () => {
  const dir = makeTempDir();
  try {
    const longLine = 'x'.repeat(1000);
    const content = longLine + '\n' + longLine + '\n' + longLine;
    const path = join(dir, 'long.txt');
    writeFileSync(path, content);
    // A tiny highWaterMark forces many reads and cross-chunk reassembly.
    const lines = await collect(createLineReader(path, { highWaterMark: 64 }));
    assert.deepEqual(lines, [longLine, longLine, longLine]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handles multi-byte UTF-8 characters that fall across a chunk boundary', async () => {
  const dir = makeTempDir();
  try {
    // The cent sign '¢' is 0xC2 0xA2 in UTF-8. Build content so the boundary
    // splits the two bytes across two reads.
    const text = 'a¢b¢c\n';
    const buf = Buffer.from(text, 'utf8');
    const path = join(dir, 'multibyte.txt');
    writeFileSync(path, buf);
    // highWaterMark=3 lands the first chunk at 'a' + first byte of '¢'.
    const lines = await collect(createLineReader(path, { highWaterMark: 3 }));
    assert.deepEqual(lines, [text.trim()]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('detects a UTF-8 BOM and strips it from the first line', async () => {
  const dir = makeTempDir();
  try {
    const path = join(dir, 'utf8bom.txt');
    writeFileSync(path, Buffer.concat([
      Buffer.from([0xEF, 0xBB, 0xBF]),
      Buffer.from('hello\nworld\n', 'utf8'),
    ]));
    const lines = await collect(createLineReader(path));
    assert.deepEqual(lines, ['hello', 'world']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('detects a UTF-16 LE BOM and reads lines correctly', async () => {
  const dir = makeTempDir();
  try {
    const path = join(dir, 'utf16le.txt');
    const bom = Buffer.from([0xFF, 0xFE]);
    const body = Buffer.from('alpha\nbravo\n', 'utf16le');
    writeFileSync(path, Buffer.concat([bom, body]));
    const lines = await collect(createLineReader(path));
    assert.deepEqual(lines, ['alpha', 'bravo']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('detects a UTF-16 BE BOM and reads lines correctly', async () => {
  const dir = makeTempDir();
  try {
    const path = join(dir, 'utf16be.txt');
    const bom = Buffer.from([0xFE, 0xFF]);
    const body = swapUTF16LEtoBE(Buffer.from('alpha\nbravo\n', 'utf16le'));
    writeFileSync(path, Buffer.concat([bom, body]));
    const lines = await collect(createLineReader(path));
    assert.deepEqual(lines, ['alpha', 'bravo']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('honours an explicit defaultEncoding for files without a BOM', async () => {
  const dir = makeTempDir();
  try {
    const path = join(dir, 'utf16le-nobom.txt');
    writeFileSync(path, Buffer.from('alpha\nbravo\n', 'utf16le'));
    const lines = await collect(createLineReader(path, { defaultEncoding: 'utf16le' }));
    assert.deepEqual(lines, ['alpha', 'bravo']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('strips a trailing CR from CRLF endings in UTF-16 LE files', async () => {
  const dir = makeTempDir();
  try {
    const path = join(dir, 'utf16le-crlf.txt');
    const bom = Buffer.from([0xFF, 0xFE]);
    const body = Buffer.from('alpha\r\nbravo\r\n', 'utf16le');
    writeFileSync(path, Buffer.concat([bom, body]));
    const lines = await collect(createLineReader(path));
    assert.deepEqual(lines, ['alpha', 'bravo']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('detectBOMEncoding returns null when no BOM is present', () => {
  assert.equal(detectBOMEncoding(Buffer.from('hello')), null);
  assert.equal(detectBOMEncoding(Buffer.from([0x68, 0x65])), null);
});

test('detectBOMEncoding recognises each supported BOM', () => {
  assert.equal(detectBOMEncoding(Buffer.from([0xEF, 0xBB, 0xBF])), 'utf8');
  assert.equal(detectBOMEncoding(Buffer.from([0xFF, 0xFE])), 'utf16le');
  assert.equal(detectBOMEncoding(Buffer.from([0xFE, 0xFF])), 'utf16be');
});

test('detectBOMEncoding recognises a UTF-8 BOM with trailing content', () => {
  assert.equal(detectBOMEncoding(Buffer.from([0xEF, 0xBB, 0xBF, 0x68])), 'utf8');
});

test('closing the reader early stops iteration', async () => {
  const dir = makeTempDir();
  try {
    const path = join(dir, 'close.txt');
    writeFileSync(path, 'one\ntwo\nthree\n');
    const iter = createLineReader(path);
    const seen = [];
    for await (const line of iter) {
      seen.push(line);
      if (seen.length === 1) await iter.close();
    }
    assert.deepEqual(seen, ['one']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects an invalid highWaterMark', () => {
  assert.throws(() => createLineReader('x', { highWaterMark: 0 }), TypeError);
  assert.throws(() => createLineReader('x', { highWaterMark: -1 }), TypeError);
  assert.throws(() => createLineReader('x', { highWaterMark: 1.5 }), TypeError);
});

test('rejects an unsupported defaultEncoding', () => {
  assert.throws(() => createLineReader('x', { defaultEncoding: 'latin1' }), TypeError);
  assert.throws(() => createLineReader('x', { defaultEncoding: 'ascii' }), TypeError);
});
