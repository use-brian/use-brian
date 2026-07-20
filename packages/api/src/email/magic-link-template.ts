// REBRAND-CUTOVER: this file contains sidan.ai runtime values that must flip to usebrian.ai when DNS + Vercel domains + OAuth consoles + webhooks are cut over. Grep REBRAND-CUTOVER.
/**
 * Magic-link email body templates — per locale.
 *
 * Kept separate from the SMTP transport so the rendering logic is
 * trivially unit-testable without a mock transport.
 *
 * See docs/architecture/platform/auth.md → "Email magic-link flow".
 */

import type { MagicLinkLocale } from '../db/magic-link-store.js'

export type MagicLinkContent = {
  subject: string
  html: string
  /** Plain-text fallback for clients that don't render HTML. */
  text: string
}

type TemplateStrings = {
  subject: string
  preheader: string
  heading: string
  body: string
  cta: string
  tagline: string
  smallPrint: string
  ignoreLine: string
  /** Label above the 6-digit passcode block, e.g. "Or enter this code:". */
  codeLabel: string
}

// Hard-coded production icon URL so the brand mark resolves even when an
// email is sent from a dev/staging environment whose `appUrl` is an
// unreachable host (e.g. localhost). The icon is a static public asset and
// is the same across every environment.
const BRAND_ICON_URL = 'https://sidan.ai/icon.png'
const BRAND_WORDMARK = 'Use Brian'

const TEMPLATES: Record<MagicLinkLocale, TemplateStrings> = {
  en: {
    subject: 'Your Use Brian sign-in link',
    preheader: 'Tap to sign in — link expires in 15 minutes.',
    heading: 'Sign in to Use Brian',
    body: 'Tap the button below to sign in. This link expires in 15 minutes and can only be used once.',
    cta: 'Sign in',
    tagline: 'Your team\'s shared brain',
    smallPrint: 'If the button does not work, copy and paste this URL into your browser:',
    ignoreLine: 'Didn’t request this? You can safely ignore this email — nothing will change.',
    codeLabel: 'Or enter this code on the sign-in screen:',
  },
  ja: {
    subject: 'Use Brian サインインリンク',
    preheader: 'タップしてサインイン — 15分間のみ有効です。',
    heading: 'Use Brian にサインイン',
    body: '下のボタンをタップしてサインインしてください。15分間有効で、一回のみご利用いただけます。',
    cta: 'サインイン',
    tagline: 'チーム共有ブレイン',
    smallPrint: 'ボタンが使えない場合は、以下の URL をブラウザに貼り付けてください：',
    ignoreLine: 'このリクエストに覚えがない場合、このメールはそのまま無視して構いません。アカウントには何の変更もありません。',
    codeLabel: 'または、サインイン画面でこのコードを入力してください：',
  },
  zh: {
    subject: '您的 Use Brian 登入連結',
    preheader: '點擊登入 — 連結 15 分鐘內有效。',
    heading: '登入 Use Brian',
    body: '點擊下方按鈕完成登入。本連結 15 分鐘內有效，僅限使用一次。',
    cta: '登入',
    tagline: '你的團隊共享大腦',
    smallPrint: '若按鈕無法運作，請將下方網址複製至瀏覽器：',
    ignoreLine: '若這封信並非由你提出，請安心忽略，你的帳號不會受到任何影響。',
    codeLabel: '或在登入畫面輸入此驗證碼：',
  },
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Render the magic-link email body in the requested locale.
 *
 * Inline-styled, table-based HTML for maximum client compatibility
 * (Gmail strips <style> blocks; Outlook's Word renderer ignores most
 * modern CSS; iOS Mail handles inline only). The plain-text variant is
 * the deliverability + accessibility belt: clients that decline HTML
 * still get the link.
 */
export function renderMagicLinkEmail(
  link: string,
  locale: MagicLinkLocale = 'en',
  /** 6-digit OTP; when present, rendered as a copy-a-code alternative to the link. */
  code?: string,
): MagicLinkContent {
  const t = TEMPLATES[locale]
  const safeLink = escapeHtml(link)
  // Only render digits — never interpolate an unexpected value into the email.
  const safeCode = code && /^\d{4,8}$/.test(code) ? code : ''

  // The passcode block: a large, letter-spaced code the user can type on any
  // device (the prefetch-proof sign-in path). Rendered only when a code is
  // supplied so the template stays backward-compatible.
  const codeBlockHtml = safeCode
    ? `<tr>
          <td style="padding:4px 32px 8px;">
            <p style="margin:0 0 10px;font-size:13px;color:#6b7080;line-height:1.5;">${escapeHtml(t.codeLabel)}</p>
            <div style="display:inline-block;padding:12px 20px;border-radius:12px;background:#f4f5fa;border:1px solid #e7e7ee;font-family:'SFMono-Regular',Menlo,Consolas,monospace;font-size:26px;font-weight:700;letter-spacing:8px;color:#0b1020;">${safeCode}</div>
          </td>
        </tr>`
    : ''

  const html = `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>${escapeHtml(t.subject)}</title>
</head>
<body style="margin:0;padding:0;background:#0b1020;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0b1020;-webkit-font-smoothing:antialiased;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;font-size:1px;line-height:1px;mso-hide:all;">${escapeHtml(t.preheader)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#0b1020;padding:40px 16px;">
  <tr>
    <td align="center">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:540px;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 18px 60px rgba(0,0,0,0.35);">
        <tr>
          <td align="center" style="background:#0b1020;background:linear-gradient(135deg,#0b1020 0%,#13213a 55%,#0a3a4f 100%);padding:40px 24px 28px;">
            <img src="${BRAND_ICON_URL}" alt="${BRAND_WORDMARK}" width="64" height="64" style="display:block;width:64px;height:64px;border-radius:14px;border:1px solid rgba(34,211,238,0.25);">
            <div style="margin-top:16px;font-size:18px;font-weight:600;color:#22d3ee;letter-spacing:0.5px;">${BRAND_WORDMARK}</div>
            <div style="margin-top:4px;font-size:12px;color:rgba(255,255,255,0.55);letter-spacing:0.3px;">${escapeHtml(t.tagline)}</div>
          </td>
        </tr>
        <tr>
          <td style="padding:36px 32px 8px;">
            <h1 style="margin:0 0 12px;font-size:22px;font-weight:700;color:#0b1020;line-height:1.3;">${escapeHtml(t.heading)}</h1>
            <p style="margin:0 0 28px;font-size:15px;line-height:1.6;color:#3a3f50;">${escapeHtml(t.body)}</p>
            <table role="presentation" cellspacing="0" cellpadding="0" border="0">
              <tr>
                <td style="border-radius:12px;background:#0b1020;">
                  <a href="${safeLink}" style="display:inline-block;padding:14px 32px;color:#22d3ee;text-decoration:none;font-size:15px;font-weight:600;border-radius:12px;letter-spacing:0.2px;">${escapeHtml(t.cta)} &rarr;</a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        ${codeBlockHtml}
        <tr>
          <td style="padding:28px 32px 8px;">
            <p style="margin:0 0 8px;font-size:13px;color:#6b7080;line-height:1.5;">${escapeHtml(t.smallPrint)}</p>
            <p style="margin:0;font-size:12px;word-break:break-all;line-height:1.5;"><a href="${safeLink}" style="color:#0ea5b7;text-decoration:none;">${safeLink}</a></p>
          </td>
        </tr>
        <tr>
          <td style="padding:24px 32px 0;">
            <div style="height:1px;background:#e7e7ee;line-height:1px;font-size:1px;">&nbsp;</div>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 32px 32px;">
            <p style="margin:0;font-size:12px;color:#9094a4;line-height:1.6;">${escapeHtml(t.ignoreLine)}</p>
          </td>
        </tr>
      </table>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:540px;">
        <tr>
          <td align="center" style="padding:20px 24px 0;">
            <p style="margin:0;font-size:11px;color:rgba(255,255,255,0.45);line-height:1.6;">${BRAND_WORDMARK} &middot; <a href="https://sidan.ai" style="color:#22d3ee;text-decoration:none;">sidan.ai</a></p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`

  const text = [
    `${BRAND_WORDMARK} — ${t.tagline}`,
    '',
    t.heading,
    '',
    t.body,
    '',
    link,
    ...(safeCode ? ['', `${t.codeLabel} ${safeCode}`] : []),
    '',
    t.ignoreLine,
  ].join('\n')

  return { subject: t.subject, html, text }
}
