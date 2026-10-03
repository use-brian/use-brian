import { randomUUID as id } from 'node:crypto'
import { assertOfficeArtifactSnapshot } from '@use-brian/office-model'

export function officeSearchFixture(family: 'document' | 'presentation' | 'spreadsheet', artifactId: string, workspaceId: string) {
  const common = { schemaVersion:1, capabilityVersion:1, artifactId, workspaceId, family,
    locale:'en-US', defaultLanguage:'en-US', templateVersionId:null, rootId:id(), title:'Office fixture',
    resources:[], accessibility:{title:'Office fixture'} }
  const run = { id:id(),text:'needle Office body',style:{fontFamily:'Arial',fontSizePt:12,bold:false,italic:false,underline:false,strike:false,color:'#111111'} }
  if(family==='document')return assertOfficeArtifactSnapshot({...common, sections:[{
    id:id(),page:{widthPt:612,heightPt:792,marginTopPt:72,marginRightPt:72,marginBottomPt:72,marginLeftPt:72,orientation:'portrait'},
    header:[],footer:[],showPageNumber:true,nodes:[{id:id(),kind:'paragraph',styleName:'Body',alignment:'start',runs:[run]}],
  }]})
  if(family==='presentation') {
    const masterId=id(),layoutId=id(),objectId=id()
    return assertOfficeArtifactSnapshot({...common,slideSize:{widthPt:960,heightPt:540},themeId:id(),
      masters:[{id:masterId,name:'Master',lockedObjectIds:[]}],layouts:[{id:layoutId,masterId,name:'Layout',placeholderIds:[]}],
      slides:[{id:id(),title:'Slide',masterId,layoutId,notes:[],readingOrder:[objectId],objects:[{
        id:objectId,kind:'text',geometry:{xPt:72,yPt:72,widthPt:600,heightPt:100,rotationDeg:0},locked:false,
        alignment:'start',verticalAlignment:'top',runs:[run],
      }]}],
    })
  }
  const sheetId=id()
  return assertOfficeArtifactSnapshot({...common,activeSheetId:sheetId,calculationMode:'automatic',worksheets:[{
    id:sheetId,name:'Sheet1',visibility:'visible',cells:[{id:id(),address:'A1',valueType:'string',value:'needle Office body',style:{},locked:false}],
    merges:[],rowDimensions:[],columnDimensions:[],freeze:{rows:0,columns:0},images:[],validations:[],conditionalFormats:[],
    print:{printArea:'A1:C20',paperSize:'A4',orientation:'portrait',fitToWidth:1,fitToHeight:1,
      margins:{leftIn:0.35,rightIn:0.35,topIn:0.25,bottomIn:0.25,headerIn:0,footerIn:0},
      horizontalCentered:true,verticalCentered:true,showGridLines:false,showHeadings:false},
  }]})
}
