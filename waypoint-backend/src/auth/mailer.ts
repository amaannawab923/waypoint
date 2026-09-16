import nodemailer from 'nodemailer';

// AT9 (ROAD-144). The magic-link sender, built from the operator's own
// SMTP env (spec §8). Injected into the flow service so tests use a fake
// and never send; the real transport is created lazily on first use, so
// an instance with no SMTP configured never opens a connection (the
// module itself is imported either way — it's inert until createTransport).

export type Mailer = {
  send(msg: { to: string; subject: string; text: string; html: string }): Promise<void>;
};

export function smtpConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.SMTP_HOST?.trim() && env.SMTP_FROM?.trim());
}

export function createSmtpMailer(env: NodeJS.ProcessEnv = process.env): Mailer {
  const host = env.SMTP_HOST!.trim();
  const from = env.SMTP_FROM!.trim();
  // `?.trim() || 587`, not `?? 587`: the Dockerized api service (AT13,
  // ROAD-148) sets SMTP_PORT via Compose's ${SMTP_PORT:-} when it's left
  // unset, which resolves to an empty string, not undefined — `??` would
  // have let that through as `Number('')` (0), landing on `secure: false`
  // by an accident of nodemailer's own fallback rather than this line's
  // own logic. Matches smtpConfigured's own trim-then-check above.
  const port = Number(env.SMTP_PORT?.trim() || 587);
  const user = env.SMTP_USER?.trim();
  const pass = env.SMTP_PASS;
  const transport = nodemailer.createTransport({
    host,
    port,
    // 465 is implicit TLS; anything else starts plain and upgrades with
    // STARTTLS, which nodemailer does by default when the server offers it.
    secure: port === 465,
    auth: user ? { user, pass } : undefined,
  });
  return {
    async send(msg) {
      await transport.sendMail({ from, ...msg });
    },
  };
}
