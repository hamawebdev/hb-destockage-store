// SMS OTP for FLAGGED orders only: a disabled stub (JOBS-4). CLAUDE.md non-goal: no SMS provider
// integration beyond this. Report §6 item 8: Twilio is $0.273/SMS to Algeria and Mobilis needs a
// pre-registered alphanumeric sender ID, so a real provider is a later, client-approved decision.
//
// Nothing here is wired into a request path. Turning it on later needs, all three:
//   1. SMS_OTP_ENABLED = "true" (Worker var; unset/anything else = off),
//   2. a real SmsProvider replacing DisabledSmsProvider (none exists),
//   3. the order to carry at least one risk flag.
import { isOrderFlag } from '@hb/shared/order-schema';
import { normalizePhone } from '@hb/shared/phone';

export interface SmsResult {
  sent: boolean;
  /** Why nothing was sent, when `sent` is false. */
  reason?: 'feature_off' | 'not_flagged' | 'provider_disabled' | 'invalid_phone';
}

export interface SmsProvider {
  readonly name: string;
  /** False for the stub: callers must not even build a message. */
  readonly enabled: boolean;
  send(toE164: string, text: string): Promise<SmsResult>;
}

/** The only provider in this project: sends nothing, makes no network call. */
export class DisabledSmsProvider implements SmsProvider {
  readonly name = 'disabled';
  readonly enabled = false;
  async send(): Promise<SmsResult> {
    return { sent: false, reason: 'provider_disabled' };
  }
}

export interface OtpConfig {
  SMS_OTP_ENABLED?: string;
}

export function otpFeatureEnabled(config: OtpConfig): boolean {
  return config.SMS_OTP_ENABLED === 'true';
}

/** An order is "flagged" when it carries at least one known risk flag (@hb/shared ORDER_FLAGS). */
export function isFlagged(flags: readonly string[]): boolean {
  return flags.some(isOrderFlag);
}

/** 6-digit code from the CSPRNG, uniform (rejection sampling). */
export function generateOtpCode(): string {
  const buf = new Uint32Array(1);
  const limit = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000;
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0]! < limit) return String(buf[0]! % 1_000_000).padStart(6, '0');
  }
}

export function otpText(code: string, lang: 'ar' | 'fr'): string {
  return lang === 'ar' ? `رمز تأكيد طلبك في كونتوار دو لوكس: ${code}` : `Comptoir de Luxe : votre code de confirmation est ${code}`;
}

/**
 * Decides and (if everything allows) sends an OTP. Checks run cheapest-first and return before
 * any code is generated or any provider is called. With today's configuration it always returns
 * `{sent:false}`.
 */
export async function maybeSendOtp(
  order: { flags: readonly string[]; phoneE164: string; lang: 'ar' | 'fr' },
  config: OtpConfig,
  provider: SmsProvider = new DisabledSmsProvider(),
): Promise<SmsResult & { code?: string }> {
  if (!otpFeatureEnabled(config)) return { sent: false, reason: 'feature_off' };
  if (!isFlagged(order.flags)) return { sent: false, reason: 'not_flagged' };
  if (!provider.enabled) return { sent: false, reason: 'provider_disabled' };
  // The one Algerian-mobile rule (libphonenumber pattern, @hb/shared): never a local regex.
  const phone = normalizePhone(order.phoneE164);
  if (!phone.ok) return { sent: false, reason: 'invalid_phone' };
  const code = generateOtpCode();
  const r = await provider.send(phone.e164, otpText(code, order.lang));
  return r.sent ? { ...r, code } : r;
}
