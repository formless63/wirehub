/**
 * The magic-link mail: one SMTP transport (nodemailer) behind a one-method
 * interface, so tests hand in a stub and nothing ever opens a socket.
 */

import { createTransport } from 'nodemailer';

import type { SmtpConfig } from './config.ts';

export interface MailMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** What the magic-link sender needs — nodemailer's transporter satisfies it. */
export interface MailTransport {
  sendMail(message: MailMessage): Promise<unknown>;
}

export function smtpTransport(smtp: SmtpConfig): MailTransport {
  return createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    ...(smtp.user === undefined ? {} : { auth: { user: smtp.user, pass: smtp.pass ?? '' } }),
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

export function magicLinkMessage(from: string, to: string, link: string, minutes: number): MailMessage {
  const subject = 'Sign in to the studio';
  const text = `Open this link to sign in (valid for ${minutes} minutes, once):\n\n${link}\n\nIf you did not ask for it, ignore this mail.\n`;
  const html = `<p>Open this link to sign in (valid for ${minutes} minutes, once):</p>
<p><a href="${escapeHtml(link)}">Sign in</a></p>
<p style="color:#5f5c55;font-size:12px">If you did not ask for it, ignore this mail.</p>`;
  return { from, to, subject, text, html };
}
