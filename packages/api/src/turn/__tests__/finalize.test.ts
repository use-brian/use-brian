import {describe,expect,it,vi} from 'vitest'
import {publishWithConcurrentStateDiff} from '../finalize.js'

function gate(){let open!:()=>void;const promise=new Promise<void>(resolve=>{open=resolve});return{promise,open}}

describe('[COMP:api/chat-finalization] concurrent inference and publication',()=>{
  it('finishes state input admission before publication takes its locks',async()=>{
    const inputs=gate(),reading=gate(),publish=vi.fn(async()=>{})
    const result=publishWithConcurrentStateDiff({publish,diff:async(beforeApply,ready)=>{
      reading.open();await inputs.promise;ready();await beforeApply();return 1
    }})
    await reading.promise
    expect(publish).not.toHaveBeenCalled()
    inputs.open()
    expect(await result).toEqual({status:'fulfilled',value:1})
    expect(publish).toHaveBeenCalledOnce()
  })
  it('overlaps inference with publication but applies state only after publication succeeds',async()=>{
    const inference=gate(),publication=gate(),started=gate(),write=vi.fn()
    const result=publishWithConcurrentStateDiff({
      publish:async()=>{started.open();await publication.promise},
      diff:async (beforeApply,ready)=>{ready();await started.promise;inference.open();await beforeApply();write();return 1},
    })
    await inference.promise
    expect(write).not.toHaveBeenCalled()
    publication.open()
    expect(await result).toEqual({status:'fulfilled',value:1})
    expect(write).toHaveBeenCalledOnce()
  })
  it('prevents state writes on publication refusal and drains the inference task',async()=>{
    const generated=gate(),write=vi.fn(),settled=vi.fn(),refusal=new Error('publication refused')
    await expect(publishWithConcurrentStateDiff({
      publish:async()=>{await generated.promise;throw refusal},
      diff:async (beforeApply,ready)=>{ready();generated.open();try{await beforeApply();write()}finally{settled()}},
    })).rejects.toBe(refusal)
    expect(write).not.toHaveBeenCalled()
    expect(settled).toHaveBeenCalledOnce()
  })
  it('keeps publication independent of an early state failure and returns its authentic refusal',async()=>{
    const published=vi.fn(),refusal=new Error('state authority changed')
    expect(await publishWithConcurrentStateDiff({publish:async()=>{await Promise.resolve();published()},
      diff:async()=>{throw refusal},
    })).toEqual({status:'rejected',reason:refusal})
    expect(published).toHaveBeenCalledOnce()
  })
})
