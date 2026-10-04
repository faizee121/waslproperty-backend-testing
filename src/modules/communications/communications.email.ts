function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface AnnouncementEmailInput {
  title: string;
  body: string;
  organisationName: string;
  recipientFirstName: string;
}

/** Clean Wasl Property branding, no internal implementation details (no
 * audience criteria, delivery ids, or manager identity beyond the managing
 * organisation's name). Mirrors invites.email.ts's plain hand-built
 * template convention — no template-engine dependency. */
export function renderAnnouncementEmail(input: AnnouncementEmailInput): {
  subject: string;
  html: string;
  text: string;
} {
  const safeTitle = escapeHtml(input.title);
  const safeName = escapeHtml(input.recipientFirstName);
  const safeOrg = escapeHtml(input.organisationName);
  // Body is resident-authored-free (manager-authored), but still escaped —
  // then newlines restored as <br> since it's plain text, not HTML input.
  const safeBody = escapeHtml(input.body).replace(/\n/g, '<br>');

  const html = `
    <div style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; max-width: 480px; margin: 0 auto;">
      <div style="background: #5b1a86; padding: 20px 24px; border-radius: 8px 8px 0 0;">
        <span style="color: #ffffff; font-size: 18px; font-weight: 700;">Wasl Property</span>
      </div>
      <div style="border: 1px solid #e5e5e5; border-top: none; border-radius: 0 0 8px 8px; padding: 24px;">
        <p style="font-size: 15px; color: #111; margin-top: 0;">Hi ${safeName},</p>
        <h2 style="font-size: 17px; color: #111; margin: 0 0 12px;">${safeTitle}</h2>
        <p style="font-size: 15px; color: #111; line-height: 1.5;">${safeBody}</p>
        <p style="font-size: 13px; color: #666; margin-top: 24px;">
          Sent by ${safeOrg}.
        </p>
      </div>
    </div>
  `.trim();

  const text = [
    `Hi ${input.recipientFirstName},`,
    '',
    input.title,
    '',
    input.body,
    '',
    `Sent by ${input.organisationName}.`,
  ].join('\n');

  return { subject: input.title, html, text };
}
