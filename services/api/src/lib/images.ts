// Content sniffing and metadata removal for uploaded evidence. Never trust the declared type or extension.

export type ImageType = 'image/jpeg' | 'image/png';

export function sniffImage(buf: Buffer): ImageType | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  return null;
}

/**
 * Removes EXIF/XMP (APP1), IPTC (APP13), other APPn except JFIF(APP0)/Adobe(APP14) and COM segments from a JPEG.
 * GPS coordinates and device identifiers live in these segments. Pixel data is untouched.
 */
export function stripJpegMetadata(buf: Buffer): Buffer {
  if (sniffImage(buf) !== 'image/jpeg') throw new Error('not a jpeg');
  const out: Buffer[] = [buf.subarray(0, 2)];
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) throw new Error('corrupt jpeg');
    const marker = buf[i + 1]!;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      out.push(buf.subarray(i, i + 2));
      i += 2;
      continue;
    }
    if (marker === 0xda) {
      // Start of scan: the rest is entropy-coded data up to EOI; copy verbatim.
      out.push(buf.subarray(i));
      break;
    }
    if (i + 4 > buf.length) throw new Error('corrupt jpeg');
    const len = buf.readUInt16BE(i + 2);
    const seg = buf.subarray(i, i + 2 + len);
    const isApp = marker >= 0xe0 && marker <= 0xef;
    const keep = !(isApp && marker !== 0xe0 && marker !== 0xee) && marker !== 0xfe;
    if (keep) out.push(seg);
    i += 2 + len;
  }
  return Buffer.concat(out);
}

const DROP_PNG_CHUNKS = new Set(['eXIf', 'tEXt', 'iTXt', 'zTXt', 'tIME']);

/** Removes textual/EXIF chunks from a PNG. */
export function stripPngMetadata(buf: Buffer): Buffer {
  if (sniffImage(buf) !== 'image/png') throw new Error('not a png');
  const out: Buffer[] = [buf.subarray(0, 8)];
  let i = 8;
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.subarray(i + 4, i + 8).toString('latin1');
    const end = i + 12 + len;
    if (end > buf.length) throw new Error('corrupt png');
    if (!DROP_PNG_CHUNKS.has(type)) out.push(buf.subarray(i, end));
    i = end;
    if (type === 'IEND') break;
  }
  return Buffer.concat(out);
}

export function stripMetadata(buf: Buffer, type: ImageType): Buffer {
  return type === 'image/jpeg' ? stripJpegMetadata(buf) : stripPngMetadata(buf);
}
