import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import {
  DEFAULT_FILENAME,
  DEFAULT_MIME_TYPE,
  attachmentDisposition,
  attachmentFilePath,
  attachmentsRoot,
  decodeFilenameHeader,
  isInlineSafeMimeType,
  normalizeMimeType,
  responseContentType,
  sanitizeFilename,
} from './attachmentStore.js';
import { ValidationError } from '../middleware/errors.js';

// ROAD-162 attachments. The pure half of the storage layer — no database,
// no request, no filesystem writes — so every one of these runs in CI
// whether or not Postgres is reachable. The properties asserted here are
// the ones the service layer is allowed to assume: a display name can
// never be a path, a header can never be forged, and a stored id can never
// resolve outside the root.

const ORIGINAL_ROOT = process.env.WAYPOINT_ATTACHMENTS_DIR;
afterEach(() => {
  if (ORIGINAL_ROOT === undefined) delete process.env.WAYPOINT_ATTACHMENTS_DIR;
  else process.env.WAYPOINT_ATTACHMENTS_DIR = ORIGINAL_ROOT;
});

describe('sanitizeFilename', () => {
  it('strips POSIX and Windows directory components', () => {
    expect(sanitizeFilename('../../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('..\\..\\Windows\\System32\\config')).toBe('config');
    expect(sanitizeFilename('/absolute/path/report.pdf')).toBe('report.pdf');
  });

  it('strips NUL and CR/LF, which are the header-forgery and path-truncation characters', () => {
    expect(sanitizeFilename('evil\u0000.png')).toBe('evil.png');
    expect(sanitizeFilename('a\r\nX-Injected: yes.txt')).toBe('aX-Injected: yes.txt');
    expect(sanitizeFilename('tab\there.txt')).toBe('tabhere.txt');
  });

  it('keeps non-ASCII characters — a real name in a real language is not a threat', () => {
    expect(sanitizeFilename('café-наличные-日本語.png')).toBe('café-наличные-日本語.png');
  });

  it('falls back to a default when nothing usable survives', () => {
    expect(sanitizeFilename('..')).toBe(DEFAULT_FILENAME);
    expect(sanitizeFilename('.')).toBe(DEFAULT_FILENAME);
    expect(sanitizeFilename('   ')).toBe(DEFAULT_FILENAME);
    expect(sanitizeFilename('/')).toBe(DEFAULT_FILENAME);
    expect(sanitizeFilename('\u0000')).toBe(DEFAULT_FILENAME);
  });

  it('caps the length', () => {
    expect(sanitizeFilename('a'.repeat(5000))).toHaveLength(200);
  });
});

describe('decodeFilenameHeader', () => {
  it('percent-decodes, then sanitizes', () => {
    expect(decodeFilenameHeader(encodeURIComponent('holiday photo.png'))).toBe('holiday photo.png');
    expect(decodeFilenameHeader(encodeURIComponent('café.png'))).toBe('café.png');
    // The decoded value is what carries the attack, not the raw header —
    // a raw CR/LF can't survive an HTTP header at all, %0D%0A can.
    expect(decodeFilenameHeader('a%0D%0AX-Injected:%20yes.txt')).toBe('aX-Injected: yes.txt');
    expect(decodeFilenameHeader('..%2F..%2Fetc%2Fpasswd')).toBe('passwd');
    expect(decodeFilenameHeader('shell%00.png')).toBe('shell.png');
  });

  it('falls back to the default for a missing or empty header', () => {
    expect(decodeFilenameHeader(undefined)).toBe(DEFAULT_FILENAME);
    expect(decodeFilenameHeader('')).toBe(DEFAULT_FILENAME);
    expect(decodeFilenameHeader(['a', 'b'])).toBe(DEFAULT_FILENAME);
  });

  it('does not fail an upload over a malformed escape — it sanitizes the raw text instead', () => {
    expect(decodeFilenameHeader('100%-real.png')).toBe('100%-real.png');
  });
});

describe('attachmentDisposition', () => {
  it('emits only the RFC 5987 ext-value form, with no character that could close the header', () => {
    expect(attachmentDisposition('report.pdf')).toBe("attachment; filename*=UTF-8''report.pdf");
    const header = attachmentDisposition('a"b;c\'d(e)f*g café.png\r\n');
    const prefix = "attachment; filename*=UTF-8''";
    expect(header.startsWith(prefix)).toBe(true);
    const extValue = header.slice(prefix.length);
    // Nothing left in the value can close the quoting, start a new
    // parameter, or split the response — ' ( ) * are not RFC 5987
    // attr-chars and encodeURIComponent leaves them alone, so they have to
    // be percent-encoded explicitly or the header is malformed.
    expect(extValue).toMatch(/^[A-Za-z0-9!#$&+\-.^_`|~%]*$/);
    expect(decodeURIComponent(extValue)).toBe('a"b;c\'d(e)f*g café.png\r\n');
  });
});

describe('normalizeMimeType', () => {
  it('keeps a well-formed type and drops its parameters', () => {
    expect(normalizeMimeType('image/PNG')).toBe('image/png');
    expect(normalizeMimeType('text/plain; charset=utf-16')).toBe('text/plain');
    expect(normalizeMimeType('application/vnd.ms-excel')).toBe('application/vnd.ms-excel');
  });

  it('falls back to octet-stream for anything it cannot vouch for', () => {
    expect(normalizeMimeType(undefined)).toBe(DEFAULT_MIME_TYPE);
    expect(normalizeMimeType('')).toBe(DEFAULT_MIME_TYPE);
    expect(normalizeMimeType('not-a-mime-type')).toBe(DEFAULT_MIME_TYPE);
    expect(normalizeMimeType('/png')).toBe(DEFAULT_MIME_TYPE);
    expect(normalizeMimeType('image/<script>')).toBe(DEFAULT_MIME_TYPE);
    expect(normalizeMimeType('image/png\r\nX-Injected: yes')).toBe(DEFAULT_MIME_TYPE);
  });
});

describe('isInlineSafeMimeType', () => {
  it('allows the image/PDF/plain-text set', () => {
    for (const type of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'text/plain']) {
      expect(isInlineSafeMimeType(type)).toBe(true);
    }
  });

  it('refuses everything the browser would treat as active content on this origin', () => {
    for (const type of [
      'text/html',
      'image/svg+xml',
      'application/xhtml+xml',
      'text/xml',
      'application/xml',
      'application/javascript',
      'text/javascript',
      'text/csv',
      'application/octet-stream',
    ]) {
      expect(isInlineSafeMimeType(type)).toBe(false);
    }
  });

  it('pins a charset onto text/plain so nothing has to guess one from the bytes', () => {
    expect(responseContentType('text/plain')).toBe('text/plain; charset=utf-8');
    expect(responseContentType('image/png')).toBe('image/png');
  });
});

describe('attachmentFilePath', () => {
  it('puts the file directly inside the configured root, named from the id alone', () => {
    process.env.WAYPOINT_ATTACHMENTS_DIR = '/tmp/waypoint-attachment-path-test';
    expect(attachmentFilePath('att-abc1234')).toBe(
      path.join('/tmp/waypoint-attachment-path-test', 'att-abc1234.bin'),
    );
  });

  it('refuses any id that could carry a traversal, even though ids are server-generated', () => {
    process.env.WAYPOINT_ATTACHMENTS_DIR = '/tmp/waypoint-attachment-path-test';
    for (const id of ['../escape', 'a/b', 'a\\b', '..', '', 'a\u0000b', '/etc/passwd', 'a'.repeat(200)]) {
      expect(() => attachmentFilePath(id)).toThrow(ValidationError);
    }
  });

  it('defaults under the home directory, never inside the repo', () => {
    delete process.env.WAYPOINT_ATTACHMENTS_DIR;
    expect(attachmentsRoot().endsWith(path.join('.waypoint', 'attachments'))).toBe(true);
    expect(attachmentsRoot().startsWith(process.cwd())).toBe(false);
  });
});
