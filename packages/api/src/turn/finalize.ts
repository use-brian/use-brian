/** Await both branches under the original lease. [COMP:api/chat-finalization] */
export async function publishWithConcurrentStateDiff<T>(input:{
  publish:()=>Promise<void>
  diff:(beforeApply:()=>Promise<void>,inferenceReady:()=>void)=>Promise<T>
}):Promise<PromiseSettledResult<T>>{
  type Publication={ok:true}|{ok:false;error:unknown}
  let complete!:(result:Publication)=>void
  const publication=new Promise<Publication>(resolve=>{complete=resolve})
  let inferenceReady!:()=>void
  const prepared=new Promise<void>(resolve=>{inferenceReady=resolve})
  // Attach both handlers immediately: neither an early refusal nor a failed
  // publication can leave an unhandled or detached state task.
  const state=Promise.resolve().then(()=>input.diff(async()=>{
    const result=await publication
    if(!result.ok)throw result.error
  },inferenceReady)).then((value):PromiseFulfilledResult<T>=>{inferenceReady();return{status:'fulfilled',value}},
    (reason):PromiseRejectedResult=>{inferenceReady();return{status:'rejected',reason}})
  // Finish state reads/dispatch admission before publication takes its row
  // locks. Otherwise those reads can wait behind saving and serialize it all.
  await prepared
  try{
    await input.publish()
    complete({ok:true})
  }catch(error){
    complete({ok:false,error})
    await state
    throw error
  }
  return state
}
