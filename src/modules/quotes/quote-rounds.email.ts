function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

export interface RfqInvitationEmailInput {
  contractorName: string;
  organisationName: string;
  propertyName: string;
  spaceName: string | null;
  title: string;
  category: string;
  dueAt: Date | null;
  responseUrl: string;
}

/** Sent to an invited contractor — deliberately carries only what a
 * contractor needs to decide whether to quote (property/job context,
 * scope, deadline, a secure response link) and never resident/person data
 * unrelated to the job itself. */
export function renderRfqInvitationEmail(input: RfqInvitationEmailInput): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = `Request for quote: ${input.title} — ${input.organisationName}`;
  const dueLine = input.dueAt ? `Quotes are due by ${formatDate(input.dueAt)}.` : '';
  const location = input.spaceName
    ? `${input.propertyName} — ${input.spaceName}`
    : input.propertyName;

  const html = `
    <div style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; max-width: 480px; margin: 0 auto;">
      <div style="background: #662A6F; padding: 20px 24px; border-radius: 8px 8px 0 0;">
        <span style="color: #ffffff; font-size: 18px; font-weight: 700;">Wasl Property</span>
      </div>
      <div style="border: 1px solid #e5e5e5; border-top: none; padding: 24px; border-radius: 0 0 8px 8px;">
        <p style="font-size: 15px; color: #222;">Hi ${escapeHtml(input.contractorName)},</p>
        <p style="font-size: 15px; color: #222;">
          ${escapeHtml(input.organisationName)} would like to invite you to quote on the
          following ${escapeHtml(input.category.toLowerCase())} work:
        </p>
        <p style="font-size: 16px; font-weight: 600; color: #222;">${escapeHtml(input.title)}</p>
        <p style="font-size: 14px; color: #555;">${escapeHtml(location)}</p>
        ${dueLine ? `<p style="font-size: 14px; color: #555;">${escapeHtml(dueLine)}</p>` : ''}
        <p style="margin: 24px 0;">
          <a href="${input.responseUrl}" style="background: #662A6F; color: #fff; padding: 10px 20px; border-radius: 8px; text-decoration: none; font-size: 14px; font-weight: 600;">
            View request &amp; respond
          </a>
        </p>
        <p style="font-size: 12px; color: #999;">This secure link is unique to you and this request.</p>
      </div>
    </div>
  `;

  const text = [
    `Hi ${input.contractorName},`,
    '',
    `${input.organisationName} would like to invite you to quote on the following ${input.category.toLowerCase()} work:`,
    input.title,
    location,
    dueLine,
    '',
    `View request & respond: ${input.responseUrl}`,
  ]
    .filter(Boolean)
    .join('\n');

  return { subject, html, text };
}

export interface RfqAwardedEmailInput {
  contractorName: string;
  organisationName: string;
  title: string;
  awarded: boolean;
}

/** Sent once a round is awarded — to the winner (awarded: true) and,
 * separately, to every contractor whose quote wasn't chosen (awarded:
 * false). Deliberately brief; no commercial detail about other quotes is
 * ever included. */
export function renderRfqAwardedEmail(input: RfqAwardedEmailInput): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = input.awarded
    ? `You've been awarded: ${input.title}`
    : `Update on your quote: ${input.title}`;
  const message = input.awarded
    ? `Congratulations — ${escapeHtml(input.organisationName)} has selected your quote for "${escapeHtml(input.title)}". Their team will be in touch to schedule the work.`
    : `Thank you for quoting on "${escapeHtml(input.title)}". ${escapeHtml(input.organisationName)} has decided to proceed with another contractor on this occasion.`;

  const html = `
    <div style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; max-width: 480px; margin: 0 auto;">
      <div style="background: #662A6F; padding: 20px 24px; border-radius: 8px 8px 0 0;">
        <span style="color: #ffffff; font-size: 18px; font-weight: 700;">Wasl Property</span>
      </div>
      <div style="border: 1px solid #e5e5e5; border-top: none; padding: 24px; border-radius: 0 0 8px 8px;">
        <p style="font-size: 15px; color: #222;">Hi ${escapeHtml(input.contractorName)},</p>
        <p style="font-size: 15px; color: #222;">${message}</p>
      </div>
    </div>
  `;
  const text = `Hi ${input.contractorName},\n\n${message.replace(/<[^>]+>/g, '')}`;

  return { subject, html, text };
}
