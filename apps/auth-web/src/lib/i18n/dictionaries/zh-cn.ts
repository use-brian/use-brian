/**
 * Simplified Chinese (zh-CN) dictionary for apps/auth-web. Derived from
 * `zh.ts` via OpenCC tw2sp plus a Mainland vocabulary pass. Mirror every
 * key added to `en.ts` here in the same commit, in Mainland-standard
 * Simplified Chinese (登录 not 登入, 邮箱 not 電郵).
 */
import type { Dictionary } from ".";

export const zhCN: Dictionary = {
  common: {
    product: "Use Brian",
    language: "语言",
  },
  login: {
    heading: "登录工作空间",
    body: "请使用工作邮箱。我们会发送安全登录链接及六位数验证码。",
    emailLabel: "邮箱地址",
    emailPlaceholder: "you@company.com",
    send: "发送登录链接",
    sending: "发送中...",
    sentHeading: "请查看收件箱",
    sentBody: "打开邮件链接，或输入邮件内的六位数验证码。",
    codeLabel: "六位数验证码",
    verify: "登录",
    verifying: "登录中...",
    invalidCode: "验证码无效或已过期。",
    locked: "尝试次数过多，请重新获取登录邮件。",
    unavailable: "暂时无法登录，请稍后再试。",
    confirmHeading: "确认登录",
    confirmBody: "继续在此设备登录。",
    confirmButton: "继续",
    missingToken: "此登录链接数据不完整。",
    requestNew: "获取新链接",
    linkExpired: "此登录链接已过期或已被使用。",
    enrollment: "此邮箱地址需要工作空间邀请方可登录。",
    continueWithProvider: "使用 {provider} 继续",
    or: "或",
    ssoBody: "使用您组织的身分提供者继续。",
    oidcFailed: "无法完成单一登录，请再试一次。",
  },
  invite: {
    loading: "正在加载邀请...",
    title: "加入 {workspace}",
    from: "{inviter} 邀请您加入 {workspace}。",
    generic: "您已获邀加入 {workspace}。",
    admin: "您将以管理员身分加入。",
    member: "您将以成员身分加入。",
    accept: "接受邀请",
    accepting: "正在加入...",
    signIn: "以 {email} 登录并接受",
    mismatchTitle: "请使用受邀账户",
    mismatchBody: "此邀请属于 {invited}，但您目前以 {current} 登录。",
    switchAccount: "注销并继续",
    expiredTitle: "邀请已过期",
    expiredBody: "请工作空间管理员重新发送邀请。",
    acceptedTitle: "邀请已被接受",
    acceptedBody: "请打开应用程序继续。",
    openApp: "打开应用程序",
    missingTitle: "找不到邀请",
    missingBody: "此邀请无效或已不可使用。",
    error: "无法加载邀请，请再试一次。",
  },
  refresh: {
    title: "正在重新连接",
    body: "服务器暂时无法使用。您的登录状态已保留，系统会自动重试。",
    manual: "服务器仍然无法使用。请检查连接或立即重试。",
    retry: "重试",
  },
  logout: {
    title: "要注销吗？",
    body: "返回工作空间前，您需要再次验证身分。",
    confirm: "注销",
    cancel: "取消",
  },
};
