import { sendOtpEmail, type OtpEmailPurpose } from "../services/email.service.js";
import { isEmailConfigured } from "../config/email.js";

export async function deliverOtpEmail(
  to: string,
  otp: string,
  purpose: OtpEmailPurpose,
): Promise<{ emailed: boolean; devOtp?: string }> {
  if (isEmailConfigured()) {
    try {
      await sendOtpEmail(to, otp, purpose);
      return { emailed: true };
    } catch (err) {
      console.error(`[Email] Failed to send OTP to ${to}:`, err);
      // User is already created — do not fail registration; fall back below.
    }
  } else {
    console.warn(`[Email] SMTP not configured — OTP for ${to} will be returned in API for verification flow`);
  }

  return { emailed: false, devOtp: otp };
}
