import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {engineSourceHash} from '../../scripts/engine-build';
import {ENGINE_CONTRACT_VERSION} from '../../packages/simulation-engine/src/version';
const out='artifacts/enterprise-remediation-2026-10-27',hash=engineSourceHash(),startedAt=new Date().toISOString(),steps=[];
for(const script of [out+'/enterprise-audit.ts',out+'/enterprise-behavior.ts','scripts/audit-native-enterprise.ts']){
 const started=Date.now(),result=spawnSync(process.execPath,['--import','tsx',script],{stdio:'inherit',windowsHide:true});steps.push({script,exitCode:result.status,wallMs:Date.now()-started});
 if(result.status!==0)throw new Error('Enterprise validation failed: '+script);
 if(engineSourceHash()!==hash)throw new Error('Engine source changed during validation. Discard the run and repeat.');
}
writeFileSync(out+'/validation-manifest.json',JSON.stringify({contract:ENGINE_CONTRACT_VERSION,sourceHash:hash,startedAt,finishedAt:new Date().toISOString(),steps},null,2));
