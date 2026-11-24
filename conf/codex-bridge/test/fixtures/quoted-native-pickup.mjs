// Owned integration fixture only: no session headers, external provider or application configuration.
import assert from 'node:assert/strict'
import {mkdir,readFile,writeFile,mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {execFileSync} from 'node:child_process'
import {createServer} from 'node:https'
import {skillCommandFromWire,parseSkillInputSnapshot,skillResultPayload} from '../../skill-conversation.mjs'
import {skillDigest} from '../../skill-executor.mjs'
import {SkillExecutionStore} from '../../skill-execution-store.mjs'
import {runNativeExecution} from '../../native-execution.mjs'
import {NativeExecutionProfileRuntime} from '../../native-execution-runtime.mjs'
import {measureMinimalNativeExecutionToolchain} from '../../native-execution-profile.mjs'

async function execute(){
  const chunks=[];let length=0;for await(const chunk of process.stdin){length+=chunk.length;assert.ok(length<=32768);chunks.push(chunk)}
  const {wire,snapshot,leaseVersion,agent}=JSON.parse(Buffer.concat(chunks));const command=skillCommandFromWire(wire)
  const inputs=parseSkillInputSnapshot(snapshot,command,{version:leaseVersion});assert.equal(inputs.length,0);assert.equal(command.scope.kind,'TASK');assert.equal(command.skills.length,0);assert.equal(command.usageMode,'RESPONSE_V2')
  const root=await mkdtemp(join(tmpdir(),'pickup-'));let runtime,up;let calls=0
  try{
    const dir=async n=>{const p=join(root,n);await mkdir(p,{mode:0o700});return p};const home=await dir('home');await writeFile(join(home,'auth.json'),JSON.stringify({auth_mode:'apikey',OPENAI_API_KEY:'loopback-only'}),{mode:0o600})
    const key=join(root,'key'),cert=join(root,'cert');execFileSync('/usr/bin/openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'})
    up=createServer({key:await readFile(key),cert:await readFile(cert)},async(req,res)=>{
      for await(const _ of req){};if(req.url!=='/custom/responses'||req.headers.authorization!=='Bearer loopback-only'||++calls>2){res.writeHead(400);return res.end()}
      const id='resp-'+calls,item=calls===1?{id:'fc_1',type:'function_call',call_id:'local_answer_1',name:'result_propose',arguments:JSON.stringify({summary:'fixture',artifactRefs:[],data:{answer:'native pickup fixture'}})}:{id:'msg-1',type:'message',role:'assistant',content:[{type:'output_text',text:'fixture complete'}]}
      res.writeHead(200,{'Content-Type':'text/event-stream'});for(const e of [{type:'response.created',response:{id}},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{id,status:'completed',usage:{input_tokens:10,output_tokens:2,total_tokens:12,input_tokens_details:{cached_tokens:3},output_tokens_details:{reasoning_tokens:1}}}}])res.write(`data: ${JSON.stringify(e)}\n\n`);res.end()
    });await new Promise(resolve=>up.listen(0,'127.0.0.1',resolve))
    runtime=new NativeExecutionProfileRuntime({profile:{profileId:'pickup',agentId:agent,chatModel:'gpt-5.4',chatReasoningEffort:'medium',codexBin:process.env.CYF_CODEX_BIN,codexHome:home,typedInspectionProviderNetwork:'restricted-proxy',typedInspectionProviderId:'fixture',typedInspectionProviderBaseUrl:`https://127.0.0.1:${up.address().port}/custom`,typedInspectionNetworkConnectTimeoutMs:2000,typedInspectionCaBundlePath:cert},materializerRoot:await dir('mat'),stateRoot:await dir('state'),nativeToolchain:measureMinimalNativeExecutionToolchain()})
    const store=new SkillExecutionStore({rootDirectory:await dir('store'),scope:{agentId:agent},command});const manifest=await runNativeExecution({command,inputs,entries:[],store,profileRuntime:runtime,checkActive(){},model:'gpt-5.4',effort:'medium'})
    assert.equal(calls,2);assert.equal(manifest.executionId,command.executionId);assert.equal(manifest.snapshotDigest,command.snapshotDigest);const payload=skillResultPayload(manifest);assert.deepEqual(payload.data,{answer:'native pickup fixture'});assert.deepEqual(payload.artifacts,[])
    return {executionId:command.executionId,runId:command.runId,snapshotSha256:command.snapshotDigest,manifestId:'manifest_'+skillDigest(payload),payload,calls}
  }finally{try{if(runtime)await runtime.dispose()}finally{if(up)await new Promise(r=>up.close(r));await rm(root,{recursive:true,force:true})}}
}
try{const result=await execute();await writeFile(process.env.CYF_PICKUP_RESULT,JSON.stringify(result),{mode:0o600,flag:'wx'})}catch(e){const codes=[e,e?.cause,e?.cause?.cause].map(e=>e?.code).filter(c=>typeof c==='string'&&/^[A-Z0-9_]{1,90}$/.test(c));console.error('pickup peer failed:',codes.join(':')||'FIXTURE_ERROR');process.exitCode=1}
