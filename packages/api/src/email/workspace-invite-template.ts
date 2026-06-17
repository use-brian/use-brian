/**
 * Workspace-invitation email template — i18n subject + HTML + plain-text.
 *
 * Mirrors the structure of `magic-link-template.ts` (single-column,
 * inline-styled, CTA button + copy-paste fallback) but carries the
 * invitation context: who invited you, which workspace, at what role, and
 * an optional personal note.
 *
 * Spec: docs/architecture/platform/workspaces.md → "Member invitation".
 */

export type WorkspaceInviteLocale = 'en' | 'ja' | 'zh'

export type WorkspaceInviteRole = 'admin' | 'member'

export type WorkspaceInviteRenderOpts = {
  link: string
  workspaceName: string
  inviterName: string | null
  role: WorkspaceInviteRole
  message: string | null
  locale?: WorkspaceInviteLocale
}

type WorkspaceInviteContent = {
  subject: string
  html: string
  text: string
}

// Hard-coded production icon URL so the brand mark resolves even when an
// email is sent from a dev/staging environment whose `appUrl` is an
// unreachable host (e.g. localhost). Mirrors `magic-link-template.ts` so the
// invitation and sign-in emails share one visual identity.
const BRAND_ICON_URL = 'https://sidan.ai/icon.png'
const BRAND_WORDMARK = 'sidanclaw'

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&': return '&amp;'
      case '<': return '&lt;'
      case '>': return '&gt;'
      case '"': return '&quot;'
      case "'": return '&#39;'
      default: return c
    }
  })

const COPY: Record<
  WorkspaceInviteLocale,
  {
    /** subject(inviter|null, workspace) */
    subject: (inviter: string | null, workspace: string) => string
    preheader: (workspace: string) => string
    heading: (workspace: string) => string
    /** lead sentence — inviter may be null (fall back to a neutral phrasing) */
    lead: (inviter: string | null, workspace: string) => string
    roleLine: (role: WorkspaceInviteRole) => string
    roleMember: string
    roleAdmin: string
    cta: string
    tagline: string
    expiry: string
    smallPrint: string
    ignoreLine: string
    noteLabel: string
  }
> = {
  en: {
    subject: (inviter, workspace) =>
      inviter
        ? `${inviter} invited you to ${workspace} on sidanclaw`
        : `You're invited to ${workspace} on sidanclaw`,
    preheader: (workspace) => `Accept to join ${workspace}. This invite expires in 14 days.`,
    heading: (workspace) => `Join ${workspace}`,
    lead: (inviter, workspace) =>
      inviter
        ? `${inviter} invited you to collaborate in ${workspace}, a shared brain on sidanclaw.`
        : `You've been invited to collaborate in ${workspace}, a shared brain on sidanclaw.`,
    roleLine: (role) => `You'll join as ${role === 'admin' ? 'an admin' : 'a member'}.`,
    roleMember: 'member',
    roleAdmin: 'admin',
    cta: 'Accept invitation',
    tagline: "Your team's shared brain",
    expiry: 'This invitation expires in 14 days.',
    smallPrint: 'If the button does not work, copy and paste this link into your browser:',
    ignoreLine: "If you weren't expecting this, you can safely ignore this email.",
    noteLabel: 'A note from your inviter:',
  },
  ja: {
    subject: (inviter, workspace) =>
      inviter
        ? `${inviter} さんが「${workspace}」（sidanclaw）に招待しています`
        : `「${workspace}」（sidanclaw）に招待されました`,
    preheader: (workspace) => `承認して「${workspace}」に参加しましょう。この招待は14日間有効です。`,
    heading: (workspace) => `「${workspace}」に参加`,
    lead: (inviter, workspace) =>
      inviter
        ? `${inviter} さんが、sidanclaw の共有頭脳「${workspace}」への参加を招待しています。`
        : `sidanclaw の共有頭脳「${workspace}」への参加に招待されました。`,
    roleLine: (role) => `${role === 'admin' ? '管理者' : 'メンバー'}として参加します。`,
    roleMember: 'メンバー',
    roleAdmin: '管理者',
    cta: '招待を承認',
    tagline: 'あなたのチームの共有頭脳',
    expiry: 'この招待は14日間有効です。',
    smallPrint: 'ボタンが動作しない場合は、このリンクをブラウザに貼り付けてください：',
    ignoreLine: '心当たりがない場合は、このメールを無視してください。',
    noteLabel: '招待者からのメッセージ：',
  },
  zh: {
    subject: (inviter, workspace) =>
      inviter
        ? `${inviter} 邀請您加入 sidanclaw 的「${workspace}」`
        : `您受邀加入 sidanclaw 的「${workspace}」`,
    preheader: (workspace) => `接受邀請即可加入「${workspace}」，此邀請將於 14 天後失效。`,
    heading: (workspace) => `加入「${workspace}」`,
    lead: (inviter, workspace) =>
      inviter
        ? `${inviter} 邀請您一同協作於 sidanclaw 的共享大腦「${workspace}」。`
        : `您受邀一同協作於 sidanclaw 的共享大腦「${workspace}」。`,
    roleLine: (role) => `您將以${role === 'admin' ? '管理員' : '成員'}身分加入。`,
    roleMember: '成員',
    roleAdmin: '管理員',
    cta: '接受邀請',
    tagline: '您團隊的共享大腦',
    expiry: '此邀請將於 14 天後失效。',
    smallPrint: '如果按鈕無法使用，請將此連結複製並貼到瀏覽器：',
    ignoreLine: '如果您並未預期收到此郵件，可以安全地忽略它。',
    noteLabel: '邀請者的留言：',
  },
}

export function renderWorkspaceInviteEmail(
  opts: WorkspaceInviteRenderOpts,
): WorkspaceInviteContent {
  const locale = opts.locale ?? 'en'
  const c = COPY[locale]
  const safeLink = escapeHtml(opts.link)
  const workspace = escapeHtml(opts.workspaceName)
  const inviter = opts.inviterName ? escapeHtml(opts.inviterName) : null
  const lead = c.lead(inviter, workspace)
  const roleLine = c.roleLine(opts.role)

  const noteBlock = opts.message
    ? `<div style="margin:0 0 28px;">
<div style="font-size:12px;color:#6b7080;margin-bottom:8px;letter-spacing:0.2px;">${c.noteLabel}</div>
<div style="font-size:14px;line-height:1.6;color:#3a3f50;background:#f4f6fa;border-radius:10px;padding:14px 16px;border-left:3px solid #22d3ee;white-space:pre-wrap;">${escapeHtml(opts.message)}</div>
</div>`
    : ''

  return {
    subject: c.subject(opts.inviterName, opts.workspaceName),
    html: `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>${escapeHtml(c.heading(opts.workspaceName))}</title>
</head>
<body style="margin:0;padding:0;background:#0b1020;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0b1020;-webkit-font-smoothing:antialiased;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;font-size:1px;line-height:1px;mso-hide:all;">${escapeHtml(c.preheader(opts.workspaceName))}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#0b1020;padding:40px 16px;">
  <tr>
    <td align="center">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:540px;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 18px 60px rgba(0,0,0,0.35);">
        <tr>
          <td align="center" style="background:#0b1020;background:linear-gradient(135deg,#0b1020 0%,#13213a 55%,#0a3a4f 100%);padding:40px 24px 28px;">
            <img src="${BRAND_ICON_URL}" alt="${BRAND_WORDMARK}" width="64" height="64" style="display:block;width:64px;height:64px;border-radius:14px;border:1px solid rgba(34,211,238,0.25);">
            <div style="margin-top:16px;font-size:18px;font-weight:600;color:#22d3ee;letter-spacing:0.5px;">${BRAND_WORDMARK}</div>
            <div style="margin-top:4px;font-size:12px;color:rgba(255,255,255,0.55);letter-spacing:0.3px;">${escapeHtml(c.tagline)}</div>
          </td>
        </tr>
        <tr>
          <td style="padding:36px 32px 8px;">
            <h1 style="margin:0 0 12px;font-size:22px;font-weight:700;color:#0b1020;line-height:1.3;">${escapeHtml(c.heading(opts.workspaceName))}</h1>
            <p style="margin:0 0 6px;font-size:15px;line-height:1.6;color:#3a3f50;">${lead}</p>
            <p style="margin:0 0 28px;font-size:13px;line-height:1.6;color:#6b7080;">${escapeHtml(roleLine)}</p>
            ${noteBlock}
            <table role="presentation" cellspacing="0" cellpadding="0" border="0">
              <tr>
                <td style="border-radius:12px;background:#0b1020;">
                  <a href="${safeLink}" style="display:inline-block;padding:14px 32px;color:#22d3ee;text-decoration:none;font-size:15px;font-weight:600;border-radius:12px;letter-spacing:0.2px;">${escapeHtml(c.cta)} &rarr;</a>
                </td>
              </tr>
            </table>
            <p style="margin:16px 0 0;font-size:12px;color:#9094a4;line-height:1.5;">${escapeHtml(c.expiry)}</p>
          </td>
        </tr>
        <tr>
          <td style="padding:28px 32px 8px;">
            <p style="margin:0 0 8px;font-size:13px;color:#6b7080;line-height:1.5;">${escapeHtml(c.smallPrint)}</p>
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
            <p style="margin:0;font-size:12px;color:#9094a4;line-height:1.6;">${escapeHtml(c.ignoreLine)}</p>
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
</html>`,
    text: [
      `${BRAND_WORDMARK} — ${c.tagline}`,
      '',
      c.heading(opts.workspaceName),
      '',
      COPY[locale].lead(opts.inviterName, opts.workspaceName),
      COPY[locale].roleLine(opts.role),
      ...(opts.message ? ['', c.noteLabel, opts.message] : []),
      '',
      opts.link,
      '',
      c.expiry,
      c.ignoreLine,
    ].join('\n'),
  }
}
