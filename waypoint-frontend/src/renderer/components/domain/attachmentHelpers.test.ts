import { attachmentKindOf, fileExtensionLabel, formatBytes } from './attachmentHelpers';

describe('attachmentKindOf', () => {
  it('classifies by mime type prefix', () => {
    expect(attachmentKindOf('image/png')).toBe('image');
    expect(attachmentKindOf('video/mp4')).toBe('video');
    expect(attachmentKindOf('audio/mpeg')).toBe('audio');
    expect(attachmentKindOf('application/pdf')).toBe('other');
    expect(attachmentKindOf('application/octet-stream')).toBe('other');
  });
});

describe('formatBytes', () => {
  it('formats a genuine 0-byte file as "0 B", not NaN or blank', () => {
    expect(formatBytes(0)).toBe('0 B');
  });

  it('formats bytes, kilobytes, megabytes and gigabytes', () => {
    expect(formatBytes(500)).toBe('500 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5 MB');
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe('2 GB');
  });

  it('degrades gracefully for invalid input instead of throwing', () => {
    expect(formatBytes(-5)).toBe('— B');
    expect(formatBytes(NaN)).toBe('— B');
  });
});

describe('fileExtensionLabel', () => {
  it('uppercases a normal extension', () => {
    expect(fileExtensionLabel('report.pdf')).toBe('PDF');
    expect(fileExtensionLabel('archive.tar.gz')).toBe('GZ');
  });

  it('falls back to FILE for a name with no extension', () => {
    expect(fileExtensionLabel('README')).toBe('FILE');
    expect(fileExtensionLabel('Dockerfile')).toBe('FILE');
  });

  it('falls back to FILE for a trailing dot or an unreasonable "extension"', () => {
    expect(fileExtensionLabel('weird.')).toBe('FILE');
    // Not a real extension shape: too long, and not alphanumeric.
    expect(fileExtensionLabel('archive.backup-2026')).toBe('FILE');
    expect(fileExtensionLabel('notes.really-long-suffix')).toBe('FILE');
  });
});
