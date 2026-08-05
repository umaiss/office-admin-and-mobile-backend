import { sniffMimeType } from './file-type';

/**
 * The declared `Content-Type` on a multipart upload is written by the client and
 * can say anything. These tests pin the property the receipt upload depends on:
 * the type is decided by the file's own leading bytes, so renaming a script to
 * `.jpg` and labelling it `image/jpeg` does not get it stored as an image.
 */
describe('sniffMimeType', () => {
  /** Pads a signature out past the 12-byte minimum the sniffer requires. */
  const withPadding = (...bytes: number[]) =>
    Buffer.concat([Buffer.from(bytes), Buffer.alloc(16)]);

  it('identifies a JPEG', () => {
    expect(sniffMimeType(withPadding(0xff, 0xd8, 0xff, 0xe0))).toBe(
      'image/jpeg',
    );
  });

  it('identifies a PNG', () => {
    expect(
      sniffMimeType(
        withPadding(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
      ),
    ).toBe('image/png');
  });

  it('identifies a WebP by its RIFF container tag, not the chunk length', () => {
    // "RIFF" + 4 arbitrary length bytes + "WEBP".
    const webp = Buffer.concat([
      Buffer.from('RIFF', 'ascii'),
      Buffer.from([0x24, 0x00, 0x00, 0x00]),
      Buffer.from('WEBP', 'ascii'),
      Buffer.alloc(8),
    ]);
    expect(sniffMimeType(webp)).toBe('image/webp');
  });

  it('identifies a PDF', () => {
    expect(sniffMimeType(Buffer.from('%PDF-1.7 trailing content'))).toBe(
      'application/pdf',
    );
  });

  it('rejects a script however it is named or labelled', () => {
    expect(
      sniffMimeType(Buffer.from('<?php system($_GET["c"]); ?>')),
    ).toBeNull();
  });

  it('rejects a RIFF file that is not WebP (e.g. a WAV)', () => {
    const wav = Buffer.concat([
      Buffer.from('RIFF', 'ascii'),
      Buffer.from([0x24, 0x00, 0x00, 0x00]),
      Buffer.from('WAVE', 'ascii'),
      Buffer.alloc(8),
    ]);
    expect(sniffMimeType(wav)).toBeNull();
  });

  it('rejects a buffer too short to carry any signature', () => {
    expect(sniffMimeType(Buffer.from([0xff, 0xd8, 0xff]))).toBeNull();
  });

  it('rejects an empty buffer', () => {
    expect(sniffMimeType(Buffer.alloc(0))).toBeNull();
  });
});
