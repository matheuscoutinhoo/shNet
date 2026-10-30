import {readFile,writeFile} from 'node:fs/promises';
import {engineSourceHash} from '../../scripts/engine-build.ts';
const dir=new URL('./',import.meta.url);
const json=async(name)=>{const bytes=await readFile(new URL(name,dir));return JSON.parse(bytes.toString(bytes[0]===255&&bytes[1]===254?'utf16le':'utf8').replace(/^\uFEFF/,''));};
const audit=await json('audit-current/cisco-compatibility.json');
const unit=await json('full-regression.json');
const unitReports=[];for(const name of ['firstboot-tests.json','postfix-regression.json','slow-regression.json']){try{unitReports.push({name,report:await json(name)});}catch{}}
const unitCases=(report)=>report.testResults.flatMap((file)=>file.assertionResults.map((test)=>({key:file.name+' / '+test.fullName,file:file.name,title:test.fullName,status:test.status,failureMessages:test.failureMessages})));
const initialUnit=unitCases(unit),recheckedUnit=unitReports.flatMap(({report})=>unitCases(report)).filter((row)=>!['pending','skipped','todo','disabled'].includes(row.status));
const mergedUnits=new Map(initialUnit.map((row)=>[row.key,row]));for(const row of recheckedUnit)mergedUnits.set(row.key,row);
const finalUnit=[...mergedUnits.values()];
const unresolvedUnit=finalUnit.filter((row)=>!['passed','pending','skipped','todo','disabled'].includes(row.status));
const pg=await Promise.all(['postgres-regression.json','postgres-instances.json'].map(json));
const dependencies=await json('dependency-audit.json');
const browser=await json('browser.json');
let serial;try{serial=await json('browser-serial.json');}catch{}
function cases(report){
  const rows=[];
  const visit=(s,parents=[])=>{
    const path=s.title?[...parents,s.title]:parents;
    for(const spec of s.specs??[])for(const t of spec.tests??[])rows.push({key:[...path,spec.title,t.projectName].join(' / '),title:spec.title,project:t.projectName,status:t.status,passed:t.status==='expected'&&t.results?.at(-1)?.status==='passed',results:(t.results??[]).map((r)=>({status:r.status,error:r.error?.message}))});
    for(const child of s.suites??[])visit(child,path);
  };
  for(const suite of report.suites??[])visit(suite);
  return rows;
}
const original=cases(browser),rechecks=serial?cases(serial):[];
const final=original.map((row)=>rechecks.find((r)=>r.key===row.key)??row);
const sourceHash=engineSourceHash();
const result={
  generatedAt:new Date().toISOString(),engineContract:audit.engineContract,engineSourceHash:sourceHash,
  auditSourceMatches:sourceHash===audit.engineSourceHash,
  selectedCommandChecks:audit.summary,commandRatioIsNotProductCompletion:true,
  openSelectedChecks:audit.checks.filter((c)=>c.status!=='pass').map((c)=>({id:c.id,title:c.title??c.name})),
  unit:{files:unit.testResults.length,total:finalUnit.length,initialTotal:unit.numTotalTests,passed:finalUnit.filter((row)=>row.status==='passed').length,failed:unresolvedUnit.length,skipped:finalUnit.filter((row)=>['pending','skipped','todo','disabled'].includes(row.status)).length,success:unresolvedUnit.length===0,initialRunSuccess:unit.success,initialFailures:initialUnit.filter((row)=>row.status==='failed'),postFixReports:unitReports.map(({name})=>name),serialRecheckedTests:recheckedUnit.length,unresolved:unresolvedUnit},
  postgres:{total:pg.reduce((n,r)=>n+r.numTotalTests,0),passed:pg.reduce((n,r)=>n+r.numPassedTests,0),failed:pg.reduce((n,r)=>n+r.numFailedTests,0)},
  browser:{inventory:original.length,productionInitial:browser.stats,serialRechecks:rechecks.length,finalPassed:final.filter((r)=>r.passed).length,unresolved:final.filter((r)=>!r.passed),initialFailures:original.filter((r)=>!r.passed),globalErrors:[...(browser.errors??[]),...(serial?.errors??[])]},
  dependencies:dependencies.metadata.vulnerabilities,
  limits:['Selected Cisco command checks are not complete Cisco compatibility.','Native SSH/VTY and the advanced backlog remain open.','Interrupted development runs are excluded; see aborted-runs.json.','Full runs preceded the first-boot correction. Affected unit files and browser workflows were rechecked after the fix.','One browser project covers the app, which forces its own dark appearance.']
};
await writeFile(new URL('verification.json',dir),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({unit:{files:result.unit.files,total:result.unit.total,passed:result.unit.passed,failed:result.unit.failed,skipped:result.unit.skipped},postgres:result.postgres,browser:{inventory:result.browser.inventory,passed:result.browser.finalPassed,unresolved:result.browser.unresolved.length},audit:audit.summary,dependencyAdvisories:result.dependencies.total,sourceMatches:result.auditSourceMatches}));
if(!result.unit.success||unitReports.some(({report})=>!report.success)||result.postgres.failed||original.length!==73||final.some((r)=>!r.passed)||result.browser.globalErrors.length||!result.auditSourceMatches||result.dependencies.total)process.exitCode=1;
