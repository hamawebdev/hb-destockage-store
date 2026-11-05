import { afterEach, describe, expect, test, vi } from 'vitest';
import { DisabledSmsProvider, generateOtpCode, isFlagged, maybeSendOtp, otpFeatureEnabled, otpText, type SmsProvider } from '../src/sms/otp.ts';
import { captureConsole } from './helpers/batch.ts';

const flagged = { flags: ['turnstile_missing'], phoneE164: '+213560417403', lang: 'fr' as const };

function spyProvider(enabled: boolean): SmsProvider & { send: ReturnType<typeof vi.fn> } {
  return { name: 'spy', enabled, send: vi.fn(async () => ({ sent: true })) };
}

afterEach(() => vi.restoreAllMocks());

describe('SMS OTP stub: nothing is ever sent with this project\'s configuration', () => {
  test('feature flag is off by default (unset, empty, "1", "TRUE" are all off)', () => {
    for (const v of [undefined, '', '1', 'TRUE', 'yes', 'false']) expect(otpFeatureEnabled(v === undefined ? {} : { SMS_OTP_ENABLED: v })).toBe(false);
    expect(otpFeatureEnabled({ SMS_OTP_ENABLED: 'true' })).toBe(true);
  });

  test('default config + default provider: not sent, no network, no code generated, nothing logged', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const rng = vi.spyOn(crypto, 'getRandomValues');
    const cap = captureConsole();
    let r;
    try {
      r = await maybeSendOtp(flagged, {});
    } finally {
      cap.restore();
    }
    expect(r).toEqual({ sent: false, reason: 'feature_off' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(rng).not.toHaveBeenCalled();
    expect(cap.lines).toEqual([]);
  });

  test('flag on, flagged order, the disabled provider: still nothing sent, no network', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const r = await maybeSendOtp(flagged, { SMS_OTP_ENABLED: 'true' });
    expect(r).toEqual({ sent: false, reason: 'provider_disabled' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await new DisabledSmsProvider().send()).toEqual({ sent: false, reason: 'provider_disabled' });
  });

  test('flag off: an enabled provider is never called either', async () => {
    const p = spyProvider(true);
    expect(await maybeSendOtp(flagged, {}, p)).toEqual({ sent: false, reason: 'feature_off' });
    expect(p.send).not.toHaveBeenCalled();
  });

  test('only flagged orders: unflagged or unknown flags never reach the provider', async () => {
    const p = spyProvider(true);
    expect(await maybeSendOtp({ ...flagged, flags: [] }, { SMS_OTP_ENABLED: 'true' }, p)).toMatchObject({ reason: 'not_flagged' });
    expect(await maybeSendOtp({ ...flagged, flags: ['not_a_flag'] }, { SMS_OTP_ENABLED: 'true' }, p)).toMatchObject({ reason: 'not_flagged' });
    expect(p.send).not.toHaveBeenCalled();
    expect(isFlagged(['duplicate'])).toBe(true);
  });

  test('a future real provider would be called once, for a valid Algerian mobile only', async () => {
    const p = spyProvider(true);
    expect(await maybeSendOtp({ ...flagged, phoneE164: '+213212345678' }, { SMS_OTP_ENABLED: 'true' }, p)).toMatchObject({ reason: 'invalid_phone' });
    const r = await maybeSendOtp(flagged, { SMS_OTP_ENABLED: 'true' }, p);
    expect(p.send).toHaveBeenCalledOnce();
    expect(p.send.mock.calls[0]![0]).toBe('+213560417403');
    expect(p.send.mock.calls[0]![1]).toBe(otpText(r.code!, 'fr'));
  });

  test('codes: 6 digits, varied', () => {
    const codes = new Set(Array.from({ length: 200 }, generateOtpCode));
    for (const c of codes) expect(c).toMatch(/^\d{6}$/);
    expect(codes.size).toBeGreaterThan(190);
    expect(otpText('012345', 'ar')).toContain('012345');
  });
});
