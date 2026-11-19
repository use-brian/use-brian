import { describe, expect, it } from 'vitest'
import { SendCrmMessageCommandSchema, SaveCrmMailboxIntegrationGrantCommandSchema } from '@use-brian/core/crm/operations-types.js'

const id='11111111-1111-4111-8111-111111111111'
const message={kind:'send_message',deliveryId:id,connectorInstanceId:id,purposeKey:'updates',
  to:['person@example.com'],subject:'Fixture',body:'Hello'}

describe('[COMP:crm/delivery-receipts] Bounded public delivery command',()=>{
  it('accepts only message content and canonical business references',()=>{
    expect(SendCrmMessageCommandSchema.parse(message)).toMatchObject({cc:[],bcc:[],attachments:[]})
  })
  it.each([
    {subject:'Fixture\r\nBcc: injected@example.com'},
    {to:['Display Name <person@example.com>']},
    {bcc:['bad\naddress@example.com']},
    {deliveryId:'not-a-uuid'},
    {body:'x'.repeat(200_001)},
    {authority:{canWrite:true}},
    {workspaceId:id},
    {expectedAccountHash:'0'.repeat(64)},
    {attachments:[{filename:'file.txt',mime:'text/plain',url:'https://example.com/file'}]},
    {attachments:[{filename:'file.txt',mime:'text/plain',contentBase64:'not base64'}]},
    {attachments:[{filename:'file\nname.txt',mime:'text/plain',contentBase64:'QQ=='}]},
    {to:Array.from({length:1000},()=> 'person@example.com'),cc:['other@example.com']},
  ])('refuses an invalid or authority-bearing envelope %#',overrides=>{
    expect(SendCrmMessageCommandSchema.safeParse({...message,...overrides}).success).toBe(false)
  })
  it('bounds the complete message, including aggregate attachment bytes',()=>{
    const attachment={filename:'fixture.txt',mime:'text/plain',contentBase64:'AAAA'.repeat(1024*1024)}
    expect(SendCrmMessageCommandSchema.safeParse({...message,attachments:[attachment,attachment]}).success).toBe(false)
  })
  it('requires explicit confirmed versioned mailbox approval',()=>{
    const grant={kind:'save_mailbox_integration_grant',credentialId:id,connectorInstanceId:id,expectedVersion:0,enabled:true,confirmed:true}
    expect(SaveCrmMailboxIntegrationGrantCommandSchema.safeParse(grant).success).toBe(true)
    expect(SaveCrmMailboxIntegrationGrantCommandSchema.safeParse({...grant,confirmed:false}).success).toBe(false)
    expect(SaveCrmMailboxIntegrationGrantCommandSchema.safeParse({...grant,expectedVersion:-1}).success).toBe(false)
  })
})
