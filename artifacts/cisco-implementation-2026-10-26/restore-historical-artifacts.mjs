import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve,sep,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
const repo=resolve(fileURLToPath(new URL('../../',import.meta.url)));
// These two tracked reports were clean at the beginning of the task.
// Preserve new measurements here, then restore their original historical bytes.
for(const relative of ['artifacts/application-completion-2026-10-13/case-coverage.json','artifacts/application-completion-2026-10-13/browser-heap-2000-sistema-claro.json']){
  const target=resolve(repo,relative);
  if(!target.startsWith(repo+sep))throw new Error('Artifact path outside workspace.');
  const original=execFileSync('git',['show','HEAD:'+relative],{cwd:repo,windowsHide:true});
  const current=await readFile(target);
  if(!original.equals(current)){
    await writeFile(new URL('current-'+basename(relative),import.meta.url),current);
    await writeFile(target,original);
    console.log('Preserved current measurement and restored '+relative);
  }
}
