import {test,expect,type Page} from '@playwright/test';
import {readFile,readdir,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
const out='artifacts/global-enterprise-validation-2026-10-26';
async function login(page:Page){
 const address=`enterprise-audit-${Date.now()}@example.test`,password='Disposable-Audit-123!';
 await page.goto('/');await page.getByRole('button',{name:'Criar conta',exact:true}).click();
 await page.getByLabel('Seu nome').fill('Enterprise Audit');await page.getByLabel('E-mail',{exact:true}).fill(address);await page.getByLabel('Senha',{exact:true}).fill(password);
 const registered=page.waitForResponse(r=>r.url().endsWith('/api/auth/register')&&r.request().method()==='POST');await page.getByRole('button',{name:'Criar conta',exact:true}).click();expect((await registered).status()).toBe(202);
 const capabilities=await(await page.request.get('/api/auth/capabilities')).json();
 if(capabilities.emailEnabled){
  await expect(page.getByRole('status')).toContainText('verificação');
  let link='';for(const f of await readdir('.data/mail')){const text=await readFile(resolve('.data/mail',f),'utf8');if(text.includes('To: '+address)&&text.includes('action=verify')){link=text.match(/http[^\s]+/)![0];break;}}
  expect(link).not.toBe('');await page.goto(link);await page.getByRole('button',{name:'Verificar e-mail',exact:true}).click();await expect(page.getByRole('status')).toContainText('E-mail verificado');
 }
 await page.getByLabel('E-mail',{exact:true}).fill(address);await page.getByLabel('Senha',{exact:true}).fill(password);await page.getByRole('button',{name:'Entrar no shLab',exact:true}).click();await expect(page.getByRole('heading',{name:'Meus laboratórios',exact:true})).toBeVisible();
}
async function inspect(page:Page,hostname:string){const finder=page.getByRole('textbox',{name:'Localizar equipamento'});await finder.fill(hostname);await page.getByRole('button',{name:'Localizar '+hostname,exact:true}).click();await finder.press('Escape');await page.locator('.network-device').getByText(hostname,{exact:true}).click();await expect(page.locator('.inspector-device h2')).toHaveText(hostname);}
test('Six-region enterprise: import, CLI, scenario, server replay, persistence and export',async({page})=>{
 await mkdir(out+'/screenshots',{recursive:true});const errors:string[]=[],apiFailures:unknown[]=[];page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(r.status()>=400&&r.url().includes('/api/projects'))apiFailures.push({url:r.url(),status:r.status()});});
 const topology=JSON.parse(await readFile(out+'/global-enterprise-converged.shlab.json','utf8'));await login(page);
 await page.getByRole('button',{name:'Novo laboratório',exact:true}).click();const name='Global enterprise audit '+Date.now();await page.getByLabel('Nome do laboratório').fill(name);await page.getByRole('button',{name:'Criar e abrir laboratório',exact:true}).click();
 await page.locator('input[type=file][accept=".json,.shlab.json,.netlab.json"]').setInputFiles({name:'global-enterprise.shlab.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(topology))});
 await expect(page.locator('.react-flow__node-device')).toHaveCount(topology.devices.length,{timeout:60000});
 if(await page.getByRole('button',{name:'Pausar simulação',exact:true}).count())await page.getByRole('button',{name:'Pausar simulação',exact:true}).click();
 await page.screenshot({path:out+'/screenshots/global-overview.png',fullPage:true});
 await inspect(page,'SYD-CORE-A');await page.locator('.inspector-tabs').getByRole('button',{name:'Terminal',exact:true}).click();
 const input=page.locator('.xterm-helper-textarea'),terminal=page.locator('.inspector .terminal-host');
 const cmd=async(text:string)=>{await input.focus();await page.keyboard.type(text);await page.keyboard.press('Enter');};
 await cmd('enable');await cmd('show standby brief');await expect(terminal).toContainText('ACTIVE');await cmd('show ip route | include 10.1.10.0');await expect(terminal).toContainText('10.1.10.0');
 await page.screenshot({path:out+'/screenshots/sydney-cli.png',fullPage:true});
 await cmd('configure terminal');await cmd('interface Vlan10');await cmd('ip helper-address 10.1.99.67');await expect(terminal).toContainText('DHCP relay requer interface routed de roteador');
 await page.screenshot({path:out+'/screenshots/svi-relay-rejection.png',fullPage:true});await cmd('end');
 await page.getByRole('button',{name:'Salvar',exact:true}).click();await expect(page.locator('.project-title')).toContainText('Salvo',{timeout:30000});
 await page.getByRole('button',{name:'Opções do laboratório'}).click();await page.getByRole('button',{name:'Validar rede e cenários'}).click();
 await writeFile(out+'/ui-preflight.txt',await page.getByRole('dialog').innerText());
 await page.getByRole('button',{name:'Cenários e SLA',exact:true}).click();
 const codes=['NYC','SAO','LON','FRA','SIN','SYD'];
 const scenario={name:'Six-region applications and guest isolation',durationMs:6000,intervalMs:3000,deadlineMs:2500,warmupMs:0,flows:[...codes.map(code=>({name:code+' corporate ERP',source:code+'-USER',target:'10.1.10.80',protocol:'http',expect:'allow',maxLossPercent:0,requireFinalSuccess:true})),...codes.map(code=>({name:code+' guest isolation',source:code+'-GUEST',target:'10.1.10.80',protocol:'http',expect:'deny',denyEvidence:'policy',maxLossPercent:0}))],faults:[]};
 await page.getByLabel('Definição do cenário').fill(JSON.stringify(scenario));await page.getByRole('button',{name:'Salvar cenário no laboratório',exact:true}).click();await page.getByRole('button',{name:'Executar cenário',exact:true}).click();
 const runSummary=page.getByRole('dialog').locator('summary').filter({hasText:/Six-region applications and guest isolation.*Salvo/});await expect(runSummary).toBeVisible({timeout:180000});await runSummary.click();
 await expect(page.getByRole('button',{name:'Verificar no servidor',exact:true})).toBeVisible();
 await writeFile(out+'/ui-scenario.txt',await page.getByRole('dialog').innerText());await page.screenshot({path:out+'/screenshots/scenario-results.png',fullPage:true});
 await page.getByRole('button',{name:'Verificar no servidor',exact:true}).click();await expect(page.getByRole('dialog').getByRole('status')).toContainText('resultado confirmado',{timeout:180000});
 await page.getByRole('button',{name:'Fechar',exact:true}).click();await page.getByRole('button',{name:'Salvar',exact:true}).click();await expect(page.locator('.project-title')).toContainText('Salvo');
 const projects=await(await page.request.get('/api/projects')).json(),project=await(await page.request.get('/api/projects/'+projects.find((p:any)=>p.name===name).id)).json();
 await writeFile(out+'/ui-saved-project.json',JSON.stringify(project,null,2));const runs=await(await page.request.get('/api/projects/'+project.id+'/scenario-runs')).json();await writeFile(out+'/ui-scenario-runs.json',JSON.stringify(runs,null,2));
 await page.reload();await page.getByRole('heading',{name,exact:true}).click();await expect(page.locator('.react-flow__node-device')).toHaveCount(72,{timeout:30000});
 await page.getByRole('button',{name:'Opções do laboratório'}).click();const downloading=page.waitForEvent('download');await page.getByRole('button',{name:'Exportar topologia',exact:true}).click();const download=await downloading;await download.saveAs(out+'/ui-exported.shlab.json');
 const exported=JSON.parse(await readFile(out+'/ui-exported.shlab.json','utf8'));expect(exported.devices.length).toBe(72);
 await writeFile(out+'/ui-evidence.json',JSON.stringify({name,devices:project.topology.devices.length,links:project.topology.links.length,errors,apiFailures,scenarioRuns:runs},null,2));expect(errors).toEqual([]);expect(apiFailures).toEqual([]);
});
