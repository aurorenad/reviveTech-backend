import { emailFrom, emailFromName, emailTransporter, isEmailConfigured } from "../config/email.js";

export type OtpEmailPurpose = "verification" | "password-reset";

const purposeCopy: Record<OtpEmailPurpose, { subject: string; heading: string; intro: string }> = {
  verification: {
    subject: "Verify your ecommerce account",
    heading: "Verify your email",
    intro: "Use this code to complete your ecommerce registration:",
  },
  "password-reset": {
    subject: "Reset your ecommerce password",
    heading: "Password reset",
    intro: "Use this code to reset your ecommerce password:",
  },
};

export async function sendOtpEmail(
  to: string,
  otp: string,
  purpose: OtpEmailPurpose,
): Promise<void> {
  if (!isEmailConfigured()) {
    throw new Error("Email is not configured. Set SMTP_USER and SMTP_PASS in .env");
  }

  const copy = purposeCopy[purpose];
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px">
      <h2 style="color:#127058;margin:0 0 8px">${copy.heading}</h2>
      <p style="color:#444;line-height:1.5">${copy.intro}</p>
      <p style="font-size:32px;font-weight:bold;letter-spacing:8px;color:#127058;margin:24px 0">${otp}</p>
      <p style="color:#666;font-size:14px">This code expires in 10 minutes. If you did not request this, you can ignore this email.</p>
      <hr style="border:none;border-top:1px solid #eee;margin:24px 0" />
      <p style="color:#999;font-size:12px">${emailFromName}</p>
    </div>
  `;

  await emailTransporter.sendMail({
    from: `"${emailFromName}" <${emailFrom}>`,
    to,
    subject: copy.subject,
    html,
    text: `${copy.intro} ${otp}. This code expires in 10 minutes.`,
  });
}

export async function sendTradeInDecisionEmail(input: {
  to: string;
  customerName: string;
  deviceLabel: string;
  status: "APPROVED" | "REJECTED";
  finalOfferAmount?: number | null;
  officerNotes?: string | null;
  technicianComment?: string | null;
}): Promise<void> {
  if (!isEmailConfigured()) {
    throw new Error("Email is not configured. Set SMTP_USER and SMTP_PASS in .env");
  }

  const statusText = input.status === "APPROVED" ? "Approved" : "Rejected";
  const offerLine =
    input.status === "APPROVED" && input.finalOfferAmount != null
      ? `Final approved amount: $${input.finalOfferAmount.toLocaleString()}.`
      : "";
  const techLine = input.technicianComment
    ? `Technician comment: ${input.technicianComment}`
    : "";
  const officerLine = input.officerNotes ? `Finance officer note: ${input.officerNotes}` : "";
  const subject = `Sell request ${statusText} - ${input.deviceLabel}`;

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px">
      <h2 style="color:#127058;margin:0 0 10px">Sell request update</h2>
      <p style="color:#444;line-height:1.5">Hi ${input.customerName},</p>
      <p style="color:#444;line-height:1.5">
        Your sell request for <strong>${input.deviceLabel}</strong> has been <strong>${statusText}</strong>.
      </p>
      ${offerLine ? `<p style="font-size:18px;font-weight:700;color:#127058">${offerLine}</p>` : ""}
      ${techLine ? `<p style="color:#444;line-height:1.5"><strong>Technician comment:</strong> ${input.technicianComment}</p>` : ""}
      ${officerLine ? `<p style="color:#444;line-height:1.5"><strong>Finance officer note:</strong> ${input.officerNotes}</p>` : ""}
      <p style="color:#666;font-size:14px;line-height:1.5">
        If you have questions, reply to this email or contact support.
      </p>
      <hr style="border:none;border-top:1px solid #eee;margin:24px 0" />
      <p style="color:#999;font-size:12px">${emailFromName}</p>
    </div>
  `;

  const textLines = [
    `Hi ${input.customerName},`,
    `Your sell request for ${input.deviceLabel} has been ${statusText}.`,
    offerLine,
    techLine,
    officerLine,
    "If you have questions, reply to this email or contact support.",
  ].filter(Boolean);

  await emailTransporter.sendMail({
    from: `"${emailFromName}" <${emailFrom}>`,
    to: input.to,
    subject,
    html,
    text: textLines.join("\n"),
  });
}

export async function sendTradeInPickupEmail(input: {
  to: string;
  customerName: string;
  deviceLabel: string;
}): Promise<void> {
  if (!isEmailConfigured()) {
    throw new Error("Email is not configured. Set SMTP_USER and SMTP_PASS in .env");
  }

  const subject = `Pickup required - ${input.deviceLabel}`;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px">
      <h2 style="color:#127058;margin:0 0 10px">Offer declined</h2>
      <p style="color:#444;line-height:1.5">Hi ${input.customerName},</p>
      <p style="color:#444;line-height:1.5">
        We received your decision to decline our offer for <strong>${input.deviceLabel}</strong>.
      </p>
      <p style="color:#444;line-height:1.5">
        Please come and pick up your device at our service center during business hours.
      </p>
      <hr style="border:none;border-top:1px solid #eee;margin:24px 0" />
      <p style="color:#999;font-size:12px">${emailFromName}</p>
    </div>
  `;

  await emailTransporter.sendMail({
    from: `"${emailFromName}" <${emailFrom}>`,
    to: input.to,
    subject,
    html,
    text: `Hi ${input.customerName}, you declined our offer for ${input.deviceLabel}. Please come and pick up your device at our service center.`,
  });
}

export async function sendTradeInOfferAcceptedEmail(input: {
  to: string;
  customerName: string;
  deviceLabel: string;
  finalOfferAmount: number;
}): Promise<void> {
  if (!isEmailConfigured()) {
    throw new Error("Email is not configured. Set SMTP_USER and SMTP_PASS in .env");
  }

  const subject = `Thank you for accepting our offer - ${input.deviceLabel}`;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px">
      <h2 style="color:#127058;margin:0 0 10px">Thank you for working with us</h2>
      <p style="color:#444;line-height:1.5">Hi ${input.customerName},</p>
      <p style="color:#444;line-height:1.5">
        Thank you for accepting our offer for <strong>${input.deviceLabel}</strong>.
      </p>
      <p style="font-size:18px;font-weight:700;color:#127058">
        Final offer amount: $${input.finalOfferAmount.toLocaleString()}
      </p>
      <p style="color:#444;line-height:1.5">
        Please come to our office to sign the paperwork and receive your payment.
      </p>
      <hr style="border:none;border-top:1px solid #eee;margin:24px 0" />
      <p style="color:#999;font-size:12px">${emailFromName}</p>
    </div>
  `;

  await emailTransporter.sendMail({
    from: `"${emailFromName}" <${emailFrom}>`,
    to: input.to,
    subject,
    html,
    text: `Hi ${input.customerName}, thank you for accepting our offer for ${input.deviceLabel}. Final amount: $${input.finalOfferAmount.toLocaleString()}. Please come to our office to sign the paperwork and receive your payment.`,
  });
}
