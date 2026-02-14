import { describe, it, expect } from 'vitest';

/**
 * File type detection tests
 * Tests the magic bytes detection logic used in the web viewer's downloadContent()
 * This duplicates the logic from index.ts to ensure correctness
 */

function detectFileType(bytes: Uint8Array): { ext: string; mime: string; name: string } {
  if (bytes.length < 12) return { ext: 'bin', mime: 'application/octet-stream', name: 'Binary' };
  const h = bytes.slice(0, 12);
  // Images
  if (h[0] === 0x89 && h[1] === 0x50 && h[2] === 0x4E && h[3] === 0x47) return { ext: 'png', mime: 'image/png', name: 'PNG Image' };
  if (h[0] === 0xFF && h[1] === 0xD8 && h[2] === 0xFF) return { ext: 'jpg', mime: 'image/jpeg', name: 'JPEG Image' };
  if (h[0] === 0x47 && h[1] === 0x49 && h[2] === 0x46) return { ext: 'gif', mime: 'image/gif', name: 'GIF Image' };
  if (h[0] === 0x52 && h[1] === 0x49 && h[2] === 0x46 && h[3] === 0x46 && h[8] === 0x57 && h[9] === 0x45 && h[10] === 0x42 && h[11] === 0x50) return { ext: 'webp', mime: 'image/webp', name: 'WebP Image' };
  // Video
  if (h[0] === 0x1A && h[1] === 0x45 && h[2] === 0xDF && h[3] === 0xA3) return { ext: 'webm', mime: 'video/webm', name: 'WebM Video' };
  if (h[4] === 0x66 && h[5] === 0x74 && h[6] === 0x79 && h[7] === 0x70) {
    const brand = String.fromCharCode(h[8], h[9], h[10], h[11]);
    if (brand === 'qt  ' || brand.startsWith('qt')) return { ext: 'mov', mime: 'video/quicktime', name: 'QuickTime Video' };
    return { ext: 'mp4', mime: 'video/mp4', name: 'MP4 Video' };
  }
  // Audio
  if (h[0] === 0x49 && h[1] === 0x44 && h[2] === 0x33) return { ext: 'mp3', mime: 'audio/mpeg', name: 'MP3 Audio' };
  if (h[0] === 0x66 && h[1] === 0x4C && h[2] === 0x61 && h[3] === 0x43) return { ext: 'flac', mime: 'audio/flac', name: 'FLAC Audio' };
  // Documents
  if (h[0] === 0x25 && h[1] === 0x50 && h[2] === 0x44 && h[3] === 0x46) return { ext: 'pdf', mime: 'application/pdf', name: 'PDF Document' };
  // Archives
  if (h[0] === 0x50 && h[1] === 0x4B && h[2] === 0x03 && h[3] === 0x04) return { ext: 'zip', mime: 'application/zip', name: 'ZIP Archive' };
  if (h[0] === 0x1F && h[1] === 0x8B) return { ext: 'gz', mime: 'application/gzip', name: 'Gzip Archive' };
  return { ext: 'bin', mime: 'application/octet-stream', name: 'Binary' };
}

describe('File Type Detection', () => {
  describe('Images', () => {
    it('detects PNG files', () => {
      // PNG magic: 89 50 4E 47 0D 0A 1A 0A
      const png = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D]);
      const result = detectFileType(png);
      expect(result.ext).toBe('png');
      expect(result.mime).toBe('image/png');
      expect(result.name).toBe('PNG Image');
    });

    it('detects JPEG files', () => {
      // JPEG magic: FF D8 FF
      const jpg = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01]);
      const result = detectFileType(jpg);
      expect(result.ext).toBe('jpg');
      expect(result.mime).toBe('image/jpeg');
      expect(result.name).toBe('JPEG Image');
    });

    it('detects GIF files', () => {
      // GIF magic: 47 49 46 38 (GIF8)
      const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00]);
      const result = detectFileType(gif);
      expect(result.ext).toBe('gif');
      expect(result.mime).toBe('image/gif');
      expect(result.name).toBe('GIF Image');
    });

    it('detects WebP files', () => {
      // WebP magic: RIFF....WEBP (52 49 46 46 xx xx xx xx 57 45 42 50)
      const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
      const result = detectFileType(webp);
      expect(result.ext).toBe('webp');
      expect(result.mime).toBe('image/webp');
      expect(result.name).toBe('WebP Image');
    });
  });

  describe('Video', () => {
    it('detects MP4 files (isom brand)', () => {
      // MP4 magic: ....ftypisom (xx xx xx xx 66 74 79 70 69 73 6F 6D)
      const mp4 = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6F, 0x6D]);
      const result = detectFileType(mp4);
      expect(result.ext).toBe('mp4');
      expect(result.mime).toBe('video/mp4');
      expect(result.name).toBe('MP4 Video');
    });

    it('detects MP4 files (mp42 brand)', () => {
      // MP4 magic: ....ftypmp42
      const mp4 = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6D, 0x70, 0x34, 0x32]);
      const result = detectFileType(mp4);
      expect(result.ext).toBe('mp4');
      expect(result.mime).toBe('video/mp4');
      expect(result.name).toBe('MP4 Video');
    });

    it('detects MOV files (qt brand)', () => {
      // MOV magic: ....ftypqt   (xx xx xx xx 66 74 79 70 71 74 20 20)
      const mov = new Uint8Array([0x00, 0x00, 0x00, 0x14, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20]);
      const result = detectFileType(mov);
      expect(result.ext).toBe('mov');
      expect(result.mime).toBe('video/quicktime');
      expect(result.name).toBe('QuickTime Video');
    });

    it('detects WebM files', () => {
      // WebM magic: 1A 45 DF A3 (EBML header)
      const webm = new Uint8Array([0x1A, 0x45, 0xDF, 0xA3, 0x93, 0x42, 0x82, 0x88, 0x6D, 0x61, 0x74, 0x72]);
      const result = detectFileType(webm);
      expect(result.ext).toBe('webm');
      expect(result.mime).toBe('video/webm');
      expect(result.name).toBe('WebM Video');
    });
  });

  describe('Audio', () => {
    it('detects MP3 files (ID3 tag)', () => {
      // MP3 with ID3 tag: 49 44 33 (ID3)
      const mp3 = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
      const result = detectFileType(mp3);
      expect(result.ext).toBe('mp3');
      expect(result.mime).toBe('audio/mpeg');
      expect(result.name).toBe('MP3 Audio');
    });

    it('detects FLAC files', () => {
      // FLAC magic: 66 4C 61 43 (fLaC)
      const flac = new Uint8Array([0x66, 0x4C, 0x61, 0x43, 0x00, 0x00, 0x00, 0x22, 0x10, 0x00, 0x10, 0x00]);
      const result = detectFileType(flac);
      expect(result.ext).toBe('flac');
      expect(result.mime).toBe('audio/flac');
      expect(result.name).toBe('FLAC Audio');
    });
  });

  describe('Documents', () => {
    it('detects PDF files', () => {
      // PDF magic: 25 50 44 46 (%PDF)
      const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2D, 0x31, 0x2E, 0x34, 0x0A, 0x25, 0xE2, 0xE3]);
      const result = detectFileType(pdf);
      expect(result.ext).toBe('pdf');
      expect(result.mime).toBe('application/pdf');
      expect(result.name).toBe('PDF Document');
    });
  });

  describe('Archives', () => {
    it('detects ZIP files', () => {
      // ZIP magic: 50 4B 03 04 (PK..)
      const zip = new Uint8Array([0x50, 0x4B, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00]);
      const result = detectFileType(zip);
      expect(result.ext).toBe('zip');
      expect(result.mime).toBe('application/zip');
      expect(result.name).toBe('ZIP Archive');
    });

    it('detects GZIP files', () => {
      // GZIP magic: 1F 8B
      const gz = new Uint8Array([0x1F, 0x8B, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00]);
      const result = detectFileType(gz);
      expect(result.ext).toBe('gz');
      expect(result.mime).toBe('application/gzip');
      expect(result.name).toBe('Gzip Archive');
    });
  });

  describe('Edge cases', () => {
    it('returns bin for unknown binary', () => {
      const unknown = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B]);
      const result = detectFileType(unknown);
      expect(result.ext).toBe('bin');
      expect(result.mime).toBe('application/octet-stream');
      expect(result.name).toBe('Binary');
    });

    it('returns bin for files smaller than 12 bytes', () => {
      const small = new Uint8Array([0x89, 0x50, 0x4E, 0x47]); // PNG header but too short
      const result = detectFileType(small);
      expect(result.ext).toBe('bin');
      expect(result.mime).toBe('application/octet-stream');
    });

    it('returns bin for empty input', () => {
      const empty = new Uint8Array([]);
      const result = detectFileType(empty);
      expect(result.ext).toBe('bin');
    });
  });

  describe('Real-world file headers', () => {
    it('detects actual PNG header from file', () => {
      // Real PNG header: 89 50 4E 47 0D 0A 1A 0A 00 00 00 0D 49 48 44 52
      const realPng = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D]);
      expect(detectFileType(realPng).ext).toBe('png');
    });

    it('detects M4V files as MP4 (Apple variant)', () => {
      // M4V: ....ftypM4V  (shares ftyp box structure with MP4)
      const m4v = new Uint8Array([0x00, 0x00, 0x00, 0x1C, 0x66, 0x74, 0x79, 0x70, 0x4D, 0x34, 0x56, 0x20]);
      const result = detectFileType(m4v);
      expect(result.ext).toBe('mp4');
      expect(result.mime).toBe('video/mp4');
    });
  });
});
