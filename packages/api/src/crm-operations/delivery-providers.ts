/** Production mail transports for the canonical CRM command. [COMP:crm/delivery-receipts] */
import { CrmOperationsError } from '@use-brian/core/crm/operations-types.js'
import { renderEmailBody } from '@use-brian/channels'
import { query } from '../db/client.js'
import { decryptCredentials } from '../db/credential-crypto.js'
import { normalizeStoredCredentials } from '../db/connector-store.js'
import { getConnectorConfig } from '../connector-config.js'
import { refreshGoogleAccessToken, sendGmailMessage, unpackGoogleRefreshCredential } from '../google/client.js'
import { composeMailboxMessage, sendComposedMessage } from '../mailbox/smtp.js'
import { createMailboxApi } from '../mailbox/mailbox-api.js'
import type { EmailInboxProvider } from '../agentmail/provider.js'
import { crmMailboxAccountHash } from './delivery-scope.js'
import type { PrepareCrmDelivery } from './delivery-service.js'

const unavailable = () => new CrmOperationsError('conflict','The selected delivery account is unavailable.',{reason:'delivery_account_unavailable'})
function providerReceipt(value:unknown, messageKey:string, threadKey:string): Record<string,unknown> {
  const row = value && typeof value==='object' ? value as Record<string,unknown> : {}
  const identifier = (key:string) => {
    const id=row[key]
    if(typeof id!=='string' || !id || id.length>512 || /[\r\n\0]/.test(id)) throw new Error('Invalid provider acceptance receipt')
    return id
  }
  return {messageId:identifier(messageKey),threadId:identifier(threadKey),evidence:'provider_accepted'}
}

/** Keys and provider ports are server-owned, never supplied by command input. */
export function createCrmDeliveryProvider(options:{
  encryptionKey:Buffer|null
  emailProvider:()=>EmailInboxProvider|null
  campaignMail?: {
    dkim?: { domainName: string; keySelector: string; privateKey: string }
  }
}):PrepareCrmDelivery {
  return async (admission,command) => {
    // Read and decrypt one pinned ciphertext; a separate credentials lookup
    // could use a different account revision than the one final admission checks.
    const row=(await query<{provider:string;connectedEmail:string|null;credentials:Buffer|null}>(
      'SELECT provider,connected_email AS "connectedEmail",credentials FROM connector_instance WHERE id=$1',
      [admission.connectorInstanceId],
    )).rows[0]
    if(!row || crmMailboxAccountHash(row)!==admission.accountHash) throw unavailable()
    const credentials=row.credentials && options.encryptionKey
      ? normalizeStoredCredentials(decryptCredentials(row.credentials,options.encryptionKey)) : null
    const intent={crmPurposeKey:command.purposeKey,crmTemplateKey:command.templateKey}
    const attachments=command.attachments.map(a=>({filename:a.filename,mime:a.mime,data:Buffer.from(a.contentBase64,'base64')}))
    const message={to:[...command.to],cc:[...command.cc],bcc:[...command.bcc],subject:command.subject,body:command.body,attachments,...intent}
    switch(admission.provider) {
      case 'gmail': {
        if(credentials?.type!=='oauth') throw unavailable()
        const grant=unpackGoogleRefreshCredential(credentials.client_secret), app=getConnectorConfig('google')
        const clientId=grant.appClientId ?? app?.clientId,clientSecret=grant.appClientSecret ?? app?.clientSecret
        if(!clientId || !clientSecret) throw unavailable()
        const token=await refreshGoogleAccessToken(grant.refreshToken,clientId,clientSecret)
        return {send:scope=>sendGmailMessage(token,message,scope),receipt:value=>providerReceipt(value,'id','threadId')}
      }
      case 'imap': {
        if(credentials?.type!=='imap') throw unavailable()
        let clientMessageId:string|null=null
        if (command.campaignMail) {
          if (command.campaignMail.oneClick && !options.campaignMail?.dkim) {
            throw new CrmOperationsError('conflict', 'One-click unsubscribe requires a configured DKIM signer.', { reason: 'campaign_dkim_unavailable' })
          }
          return {
            send: async scope => {
              const composed = await composeMailboxMessage({
                from: credentials.email,
                to: [...command.to],
                subject: command.subject,
                body: command.body,
                rendered: { text: command.campaignMail!.text, html: command.campaignMail!.html },
                ...(command.campaignMail!.replyTo ? { replyTo: command.campaignMail!.replyTo } : {}),
                listUnsubscribeUrl: command.campaignMail!.unsubscribeUrl,
                oneClick: command.campaignMail!.oneClick,
                ...(options.campaignMail?.dkim ? { dkim: options.campaignMail.dkim } : {}),
              })
              clientMessageId = composed.messageId
              await sendComposedMessage(credentials, composed, scope, { crmPurposeKey: command.purposeKey })
            },
            receipt:()=>({clientMessageId,evidence:'smtp_accepted'}),
          }
        }
        return {
          send:scope=>createMailboxApi({
            cacheKey:admission.connectorInstanceId,deliveryContext:scope,getSettings:async()=>credentials,
            sendComposed:async(settings,composed,context,mailIntent)=>{
              clientMessageId=composed.messageId
              await sendComposedMessage(settings,composed,context,mailIntent)
            },
          }).sendMessage(message),
          receipt:()=>({clientMessageId,evidence:'smtp_accepted'}),
        }
      }
      case 'agentmail': {
        const provider=options.emailProvider()
        if(!provider || !row.connectedEmail) throw unavailable()
        const rendered=renderEmailBody(command.body),inboxId=row.connectedEmail
        return {send:scope=>provider.sendMessage(inboxId,{
          to:message.to,cc:message.cc,bcc:message.bcc,subject:message.subject,
          text:rendered.text,html:rendered.html,...intent,
          attachments:command.attachments.map(a=>({filename:a.filename,contentType:a.mime,contentBase64:a.contentBase64})),
        },scope),receipt:value=>providerReceipt(value,'message_id','thread_id')}
      }
    }
  }
}
