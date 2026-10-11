import { describe, it, expect, vi } from 'vitest';

const createTransport = vi.fn(() => ({ sendMail: vi.fn() }));
vi.mock('nodemailer', () => ({ default: { createTransport: (...args: unknown[]) => createTransport(...args) } }));

const { createSmtpMailer } = await import('./mailer.js');

function baseEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  return { SMTP_HOST: 'smtp.example.com', SMTP_FROM: 'noreply@example.com', ...overrides } as NodeJS.ProcessEnv;
}

describe('createSmtpMailer', () => {
  it('defaults to port 587, non-secure, when SMTP_PORT is unset entirely', () => {
    createSmtpMailer(baseEnv());
    expect(createTransport).toHaveBeenLastCalledWith(expect.objectContaining({ port: 587, secure: false }));
  });

  // AT13 (ROAD-148): the Dockerized api service sets SMTP_PORT via
  // Compose's ${SMTP_PORT:-}, which resolves to an EMPTY STRING when the
  // operator leaves it unset — not undefined, the case above. Before this
  // fix, `Number('') ?? 587` never fell back (`??` only catches
  // null/undefined), so this env produced port 0, secure: false — the
  // right secure value by coincidence, not by this code's own logic, and
  // not the documented "defaults to 587" behavior at all.
  it('still defaults to port 587 when SMTP_PORT is an empty string', () => {
    createSmtpMailer(baseEnv({ SMTP_PORT: '' }));
    expect(createTransport).toHaveBeenLastCalledWith(expect.objectContaining({ port: 587, secure: false }));
  });

  it('uses a real configured port, and marks 465 as secure', () => {
    createSmtpMailer(baseEnv({ SMTP_PORT: '465' }));
    expect(createTransport).toHaveBeenLastCalledWith(expect.objectContaining({ port: 465, secure: true }));
  });

  it('trims whitespace the same way smtpConfigured does', () => {
    createSmtpMailer(baseEnv({ SMTP_PORT: '  2525  ' }));
    expect(createTransport).toHaveBeenLastCalledWith(expect.objectContaining({ port: 2525, secure: false }));
  });

  // Round-5 review: Number.isInteger alone isn't a port check — 0,
  // negative numbers, and anything past 65535 all pass it. Each of these
  // must still fall back to 587, with a warning naming the rejected
  // value rather than a silent, wrong-port send.
  it.each([
    ['smtp', 'not a number at all'],
    ['587.5', 'not an integer'],
    ['0', 'zero is not a real port'],
    ['-1', 'negative'],
    ['99999', 'past the real port range'],
    ['"2525"', 'a stray quote surviving a compose env_file'],
  ])('falls back to 587, and warns, for an invalid SMTP_PORT=%s (%s)', (value) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      createSmtpMailer(baseEnv({ SMTP_PORT: value }));
      expect(createTransport).toHaveBeenLastCalledWith(expect.objectContaining({ port: 587 }));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(JSON.stringify(value)));
    } finally {
      warn.mockRestore();
    }
  });

  it('does not warn for a real, valid port', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      createSmtpMailer(baseEnv({ SMTP_PORT: '2525' }));
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
