"""Width and height of a TIFF ink map from its header, with two small range reads instead of the whole file.

Official whole-segment maps reach gigapixels (a PHercParis4 map is 2.4 Gpx, 254 MB). Reading the first IFD lets the
server answer /api/dims and decide between full resolution and the published preview before downloading anything.
Classic TIFF and BigTIFF, either byte order; only tags 256 (ImageWidth) and 257 (ImageLength) are read.
"""
import struct

WIDTH, LENGTH = 256, 257
TYPES = {3: ('H', 2), 4: ('I', 4), 16: ('Q', 8)}  # SHORT, LONG, LONG8


SKIP_LIMIT = 64 * 2**20


def _read(source, rel, start, size):
    with source.abrir(rel, rango=f'bytes={start}-{start + size - 1}') as (status, _, body):
        if status == 200 and start:
            # A server that ignores Range sends the file from the start: skip to the offset, within reason.
            if start > SKIP_LIMIT:
                raise ValueError('The server ignores byte ranges; TIFF header too far into the file')
            while start:
                chunk = body.read(min(start, 2**20))
                if not chunk:
                    return b''
                start -= len(chunk)
        return body.read(size)


def tiff_dims(source, rel):
    head = _read(source, rel, 0, 16)
    if head[:2] not in (b'II', b'MM'):
        raise ValueError('Not a TIFF header')
    e = '<' if head[:2] == b'II' else '>'
    magic = struct.unpack(e + 'H', head[2:4])[0]
    if magic == 42:
        offset, count_fmt, entry, value_at = struct.unpack(e + 'I', head[4:8])[0], 'H', 12, 8
    elif magic == 43:
        offset, count_fmt, entry, value_at = struct.unpack(e + 'Q', head[8:16])[0], 'Q', 20, 12
    else:
        raise ValueError('Not a TIFF header')
    count_size = struct.calcsize(count_fmt)
    ifd = _read(source, rel, offset, 4096)
    if len(ifd) < count_size:
        raise ValueError('TIFF directory outside the file')
    count = struct.unpack(e + count_fmt, ifd[:count_size])[0]
    found = {}
    for i in range(min(count, (len(ifd) - count_size) // entry)):
        raw = ifd[count_size + i * entry: count_size + (i + 1) * entry]
        tag, kind = struct.unpack(e + 'HH', raw[:4])
        if tag in (WIDTH, LENGTH) and kind in TYPES:
            fmt, size = TYPES[kind]
            found[tag] = struct.unpack(e + fmt, raw[value_at:value_at + size])[0]
        if len(found) == 2:
            return found[WIDTH], found[LENGTH]
    raise ValueError('TIFF size tags not found in the first IFD')
