import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { migrateModelTemplate, fileAuthToml, planModelAuthMigration, applyModelAuthMigration } from '../tools/migrate-model-auth.mjs';
import { runtimeSubjectKey } from '../lib/manifest.mjs';
import { validateHostingConfig } from '../lib/hosting-config.mjs';
import { redact } from '../lib/security.mjs';
const legacy = () => ({ profile:{codexBin:'/bin/true'}, codexConfig:'model_provider = "managed"\n[model_providers.managed]\nbase_url = "https://no-network.invalid/v1"\nwire_api = "responses"\nenv_key = "CYF_MANAGED_PROVIDER_API_KEY"\nrequires_openai_auth = false\n', providerEnvironment:{CYF_MANAGED_PROVIDER_API_KEY:'model-migration-only'} });
const save=async(p,v)=>writeFile(p,typeof v==='string'?v:JSON.stringify(v),{mode:0o600});
async function fixture(t){
 const root=await mkdtemp(resolve(tmpdir(),'auth-migrate-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const managed=resolve(root,'managed');await mkdir(managed,{mode:0o700});
 const subject={tenantId:'0',clientId:'fixture',canonicalAgentId:'agt_first',ownerJiacn:'owner'};
 const targetOnly={...subject,canonicalAgentId:'agt_target'}; const key=runtimeSubjectKey(subject),other=runtimeSubjectKey(targetOnly);
 const config={configVersion:1,managedRoot:managed,socketPath:resolve(root,'s.sock'),socketGid:0,scopes:[{tenantId:'0',clientId:'fixture',ownerJiacn:'owner'}],enrollmentTtlMs:1000,template:legacy()};
 const configPath=resolve(root,'hosting.json');await save(configPath,config);const hostPath=resolve(root,'host.json');await save(hostPath,{hostingControlPath:configPath,agents:[]});
 const journalPath=resolve(managed,'hosting-journal.json');const journal={formatVersion:2,hostId:'host',subjects:{[key]:{manifest:subject,template:legacy(),latestGeneration:2,activeOperationKey:'unchanged'}},operations:{immutable:{candidate:{manifest:{installationId:'keep'}},admittedAt:55}}};await save(journalPath,journal);
 await save(resolve(managed,`target-${other}.json`),{formatVersion:1,subject:targetOnly,template:legacy()});
 const home=resolve(managed,key,'home');await mkdir(home,{recursive:true,mode:0o700});await save(resolve(home,'config.toml'),legacy().codexConfig);
 return {root,managed,hostPath,configPath,journalPath,journal,home,key,other};
}
test('one-time conversion removes old auth only; runtime rejects old schema and extra secret consumers',()=>{
 const old=legacy(),next=migrateModelTemplate(old);assert.deepEqual(next.modelAuth,{auth_mode:'apikey',OPENAI_API_KEY:'model-migration-only'});assert.equal(next.providerEnvironment,undefined);assert.doesNotMatch(next.codexConfig,/env_key|preferred_auth_method/);assert.match(next.codexConfig,/requires_openai_auth = true/);
 assert.deepEqual(migrateModelTemplate(next),next);assert.equal(migrateModelTemplate(null),null);
 assert.throws(()=>migrateModelTemplate({...old,providerEnvironment:{...old.providerEnvironment,OTHER:'do-not-drop'}}));
 assert.throws(()=>migrateModelTemplate({...next,providerEnvironment:old.providerEnvironment}));
 assert.equal(fileAuthToml(next.codexConfig),next.codexConfig);
 assert.equal(redact('message model-migration-only'),'message [REDACTED]');
});
test('complete migration includes target-only and frozen journal, does not activate/create historical roots, preserves operations and is idempotent',async t=>{
 const f=await fixture(t);const plan=await planModelAuthMigration(f.hostPath);
 assert.ok(plan.some(row=>row.path.endsWith(`target-${f.other}.json`)));assert.ok(plan.some(row=>row.path===resolve(f.home,'auth.json')));
 await applyModelAuthMigration(plan,resolve(f.root,'backup'));
 const after=JSON.parse(await readFile(f.journalPath));assert.deepEqual(after.operations,f.journal.operations);assert.equal(after.subjects[f.key].latestGeneration,2);
 assert.equal(JSON.parse(await readFile(resolve(f.home,'auth.json'))).auth_mode,'apikey');assert.equal((await stat(resolve(f.home,'auth.json'))).mode&0o777,0o600);
 await assert.rejects(stat(resolve(f.managed,f.other)),{code:'ENOENT'});
 validateHostingConfig(JSON.parse(await readFile(f.configPath)));
 assert.deepEqual(await planModelAuthMigration(f.hostPath),[]);
});
test('CAS rejects changed inputs before mutation; partial write failure restores original bytes and removes only newly created files',async t=>{
 const f=await fixture(t);const plan=await planModelAuthMigration(f.hostPath);const before=await readFile(f.configPath);
 await save(f.configPath,'changed');await assert.rejects(applyModelAuthMigration(plan,resolve(f.root,'no-write')),{code:'AUTH_MIGRATION_CAS_CONFLICT'});await writeFile(f.configPath,before);
 await assert.rejects(applyModelAuthMigration(plan,resolve(f.root,'backup'),{beforeWrite:(_row,index)=>{if(index===plan.length-1)throw Error('injected');}}),/injected/);
 for(const row of plan){if(row.before===null) await assert.rejects(readFile(row.path),{code:'ENOENT'});else assert.deepEqual(await readFile(row.path),row.before);}
});
