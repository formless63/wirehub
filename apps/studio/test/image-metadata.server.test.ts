/**
 * A note's photo is stored without its location: the strip keeps the coded picture
 * and the orientation only, and refuses what it cannot walk rather than storing it as sent.
 */

import { describe, expect, it } from 'vitest';

import { stripJpegMetadata } from '../server/image-metadata.ts';

// a synthetic 16×8 JPEG (generated, no real photo): EXIF with Make, Orientation 6 and a GPS IFD, plus a comment
const GPS_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/4QB+RXhpZgAATU0AKgAAAAgAAwEPAAIAAAANAAAAMgESAAMAAAABAAYAAIglAAQAAAABAAAAQAAAAABTeW50aGV0aWNDYW0AAAACAAEAAgAAAAJOAAAAAAIABQAAAAMAAABeAAAAAAAAAAwAAAABAAAAIgAAAAEAAAA4AAAAAf/+AAtzeW50aGV0aWP/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAAIABADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDHooorhPqD/9k=',
  'base64',
);

describe('photo metadata strip', () => {
  it('drops EXIF (GPS, camera) and comments, keeps the coded picture and the orientation, and is idempotent', () => {
    const out = stripJpegMetadata(GPS_JPEG);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out).toMatchObject({ width: 16, height: 8, orientation: 6 });
    expect(out.removed).toEqual(['EXIF', 'comment']);
    const text = out.bytes.toString('latin1');
    expect(text).not.toContain('SyntheticCam');
    expect(text).not.toContain('synthetic');
    // the GPS IFD pointer tag (0x8825) is gone: the only EXIF left is the one-entry orientation block
    expect(out.bytes.includes(Buffer.from([0x88, 0x25]))).toBe(false);
    // the scan data is byte for byte the original's
    const sos = (b: Buffer): Buffer => b.subarray(b.indexOf(Buffer.from([0xff, 0xda])));
    expect(sos(out.bytes).equals(sos(GPS_JPEG))).toBe(true);
    const again = stripJpegMetadata(out.bytes);
    expect(again.ok && again.bytes.equals(out.bytes)).toBe(true);
  });

  it('refuses a JPEG it cannot walk to the end instead of storing it as sent', () => {
    expect(stripJpegMetadata(GPS_JPEG.subarray(0, 400)).ok).toBe(false);
    expect(stripJpegMetadata(Buffer.from('not a jpeg')).ok).toBe(false);
  });
});
