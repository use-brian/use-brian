INSERT INTO users(id,auth_provider,auth_provider_id,name) VALUES
 ('f8135000-0000-4000-8000-000000000001','test','privacy-owner','Fictional capture owner'),
 ('f8135000-0000-4000-8000-000000000002','test','privacy-admin','Fictional capture admin'),
 ('f8135000-0000-4000-8000-000000000003','test','privacy-member','Fictional capture member');
INSERT INTO workspaces(id,name,owner_user_id) VALUES('f8135000-0000-4000-8000-000000000010','Fictional legacy recording','f8135000-0000-4000-8000-000000000001');
INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES
 ('f8135000-0000-4000-8000-000000000010','f8135000-0000-4000-8000-000000000001','owner','confidential'),
 ('f8135000-0000-4000-8000-000000000010','f8135000-0000-4000-8000-000000000002','admin','confidential'),
 ('f8135000-0000-4000-8000-000000000010','f8135000-0000-4000-8000-000000000003','member','internal');
INSERT INTO assistants(id,name,workspace_id,clearance) VALUES('f8135000-0000-4000-8000-000000000020','Fictional recorder','f8135000-0000-4000-8000-000000000010','internal');
INSERT INTO channels(id,workspace_id,channel_type,display_name) VALUES('f8135000-0000-4000-8000-000000000030','f8135000-0000-4000-8000-000000000010','telegram','Fictional legacy bot');
INSERT INTO channel_integrations(id,channel_id,channel_type,credentials,bot_user_id) VALUES('f8135000-0000-4000-8000-000000000040','f8135000-0000-4000-8000-000000000030','telegram','\x00'::bytea,'987654350');
INSERT INTO sessions(id,assistant_id,user_id,workspace_id,channel_type,channel_id,visibility,anchor_kind,anchor_ref,effective_clearance,clearance_source,title)
 VALUES('f8135000-0000-4000-8000-000000000050','f8135000-0000-4000-8000-000000000020','f8135000-0000-4000-8000-000000000003','f8135000-0000-4000-8000-000000000010','telegram','-1000000350:topic:35','workspace','channel','-1000000350:topic:35','internal','anchor','Fictional protected legacy title');
INSERT INTO session_messages(id,session_id,role,content,sequence_num,channel_message_id,sender_user_id)
 VALUES('f8135000-0000-4000-8000-000000000060','f8135000-0000-4000-8000-000000000050','user','[{"type":"text","text":"Fictional protected legacy body"}]'::jsonb,1,'35','f8135000-0000-4000-8000-000000000003');
