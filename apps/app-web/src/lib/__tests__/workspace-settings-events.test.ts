// @vitest-environment jsdom
import { describe,expect,it } from 'vitest';
import { OPEN_SETTINGS_EVENT,openWorkspaceSettings,type OpenSettingsDetail } from '../workspace-settings-events';

describe('[COMP:app-web/organization-chart] scoped person settings navigation',()=>{
  it('carries only the selected member identity and originating workspace',()=>{
    const events:OpenSettingsDetail[]=[];
    const listener=(event:Event)=>events.push((event as CustomEvent<OpenSettingsDetail>).detail);
    window.addEventListener(OPEN_SETTINGS_EVENT,listener);
    try{
      openWorkspaceSettings('ws-members',{workspaceId:'workspace-fixture',memberId:'person-fixture'});
      expect(events).toEqual([{section:'ws-members',memberTarget:{workspaceId:'workspace-fixture',memberId:'person-fixture'}}]);
    }finally{window.removeEventListener(OPEN_SETTINGS_EVENT,listener)}
  });
  it('does not carry a member selection into another settings section',()=>{
    let detail:OpenSettingsDetail|undefined;
    const listener=(event:Event)=>{detail=(event as CustomEvent<OpenSettingsDetail>).detail};
    window.addEventListener(OPEN_SETTINGS_EVENT,listener);
    try{openWorkspaceSettings('ws-general',{workspaceId:'workspace-fixture',memberId:'person-fixture'});expect(detail).toEqual({section:'ws-general'})}
    finally{window.removeEventListener(OPEN_SETTINGS_EVENT,listener)}
  });
});
