# Text File Line Reader

Reads a text file line by line as an async iterator, with configurable chunk
buffering and BOM-based encoding detection.

```js
import { createLineReader } from 'text-file-line-reader';
import { writeFileSync } from 'node:fs';

writeFileSync('./data.log', 'alpha\nbravo\ncharlie\n');

const reader = createLineReader('./data.log', { highWaterMark: 4096 });
for await (const line of reader) {
  console.log(line);
}
```

`createLineReader(path, options?)` returns an async iterable yielding one line
per iteration, without the terminating newline. The iterable also exposes a
`close()` method to release the file handle before iteration completes.
`detectBOMEncoding(buffer)` is exported separately for callers that want to
inspect a buffer's leading bytes without opening a reader.

## Why this exists

The problem is reading potentially large text files line by line without
loading the whole file into memory, while still honouring the file's declared
encoding when it has a Byte Order Mark. Node's stream APIs can do this, but
they carry a lot of machinery for a task that, at its core, is: read a chunk,
find newlines, decode, repeat.

The trade-off: this library works in the byte domain and uses Node's `Buffer`
for decoding, which means it only supports encodings whose multi-byte
sequences `Buffer.toString` can decode incrementally without splitting across
chunk boundaries — UTF-8, UTF-16 LE, and UTF-16 BE. `latin1` and `ascii` are
not supported as defaults because they have no BOM and would silently
circumvent detection. If you need those, decode the file yourself.

## Edge cases you will hit

A final line that has no trailing newline is still yielded exactly once; the
reader does not silently drop trailing content. CRLF endings are handled for
all three supported encodings — the CR is treated as part of the line ending
and stripped, so you never see a trailing `\r` in a yielded line. UTF-16
scanning inspects whole 16-bit code units, so a `0x0A` byte that is merely the
high or low half of a non-LF character is not mistaken for a newline.

The `highWaterMark` controls read granularity, not line length: lines longer
than the chunk size are reassembled transparently, at the cost of buffering
the partial line in memory until its terminator arrives.

## Design notes

The window stores values eagerly rather than keeping running aggregates. Running
sums drift with floating point over long streams, and recomputing from a small
buffer is cheap enough that the drift is not worth the speed.

## Limitations

Values are coerced to floats, so very large integers lose precision. If you need
exact integer aggregates over a window, this is the wrong tool.

