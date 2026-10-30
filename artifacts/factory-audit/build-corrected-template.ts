import { readFileSync,writeFileSync } from 'node:fs';
import { SimulationEngine,configureModbus,validateSnapshot } from '../../packages/simulation-engine/src';
const e=new SimulationEngine(JSON.parse(readFileSync('artifacts/factory-audit/factory-final.shlab.json','utf8')));
for (const d of e.state.devices) {
  if (d.firewall?.zonePolicy) {
    d.firewall.zonePolicy.rules=d.firewall.zonePolicy.rules.filter(r=>!(r.from==='WIFI' && r.to==='DMZ' && r.destinationPort===80));
    d.firewall.sessions=[];
  }
  if (/^PLC-/.test(d.hostname)) {
    d.tcpServices=d.tcpServices?.filter(s=>s.port!==502);
    d.profile='plc';
    configureModbus(e,d,{enabled:true,port:502,unit:1,registers:[725,1,0,...Array(125).fill(0)]});
  }
  if (/^HMI-/.test(d.hostname) && d.type==='pc') d.profile='hmi';
  if (d.wireless) d.physicalPosition={x:d.position.x/4,y:d.position.y/4};
  d.logs=[];
}
e.state.events=[];e.state.probes=[];delete e.state.diagnostics;delete e.state.capture;
e.state.notes='Fábrica: TI, DMZ, SCADA, células A/B, CCTV, visitantes e gerência. Dois firewalls com VRRP, relay DHCP nos dois membros e retorno WAN pelo VIP. Visitantes não acessam o MES. PLCs: Modbus 03/06/16; RF com posições físicas independentes. Cenários e revisão disponíveis no menu Validar fábrica. Serviços e switches de célula ainda exigem avaliação de redundância. SCADA/MES/vídeo usam cargas substitutas; protocolos de anel industrial, PTP/TSN e firmware não são emulados.';
const snapshot=validateSnapshot(e.snapshot());
writeFileSync('packages/simulation-engine/src/factory-template.json',JSON.stringify(snapshot));
writeFileSync('artifacts/factory-audit/factory-corrected.shlab.json',JSON.stringify(snapshot,null,2));
console.log(JSON.stringify({devices:snapshot.devices.length,links:snapshot.links.length,bytes:JSON.stringify(snapshot).length}));
