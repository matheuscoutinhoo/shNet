import { interfaceSchema, BROADCAST, LIMITS, type Action, type Device, type Frame, type NetworkInterface, type Snapshot } from '../model';
import type { SimulationEngine } from '../core/engine';
import { bondMonitorSchema, type BondMonitor } from './bond-model';
import { bondActive } from './bond-members';
import { protocolDevices, invalidateProtocolIndex } from '../core/protocol-index';
import { linksAt } from '../core/topology-index';
import { linkOperational } from '../links/physical';
import { isUnicast } from './dhcp-config';
import { frame6 } from './ipv6-wire';

export function configureBond(e: SimulationEngine, d: Device, number: number, members: string[], primary: string, monitor?: BondMonitor) {
  const watched = monitor === undefined ? undefined : bondMonitorSchema.parse(monitor);
  if (!['pc','server'].includes(d.type) || !Number.isInteger(number) || number < 1 || number > 64 || members.length < 2 || members.length > 8 || new Set(members).size !== members.length || !members.includes(primary) || (watched && !isUnicast(watched.target)))
    throw new Error('Bond ativo/backup exige host, grupo 1..64, duas a oito NICs e primária participante.');
  const old = d.interfaces.find(p => p.bond?.number === number), physical = members.map(id => d.interfaces.find(p => p.id === id));
  if (physical.some(p => !p || p.logical || p.aggregate || p.bond || p.loopback || !['rj45','sfp','qsfp'].includes(p.media) || p.duplex !== 'full' || p.mode !== 'routed' || (p.channel && p.channel !== old?.id) || p.ipv6 || p.dhcp || p.dhcp6 || p.dhcpRelay?.length || p.vrf || p.aclIn || p.aclOut || p.natRole || p.dot1x || p.supplicant || p.tunnel || p.vxlan || (p.ip && (p.id !== primary || !!old)) || d.dhcpServer?.pools.some(pool => pool.port === p.id) || d.dhcp6Server?.pools.some(pool => pool.port === p.id)))
    throw new Error('NICs devem estar livres de DHCP/IPv6/políticas; somente o IPv4 estático da primária pode ser movido.');
  if (!old && d.interfaces.length >= 48) throw new Error('Limite de interfaces.');
  const base = physical.find(p => p!.id === primary)!, mtu = Math.min(...physical.map(p => p!.mtu));
  if (old && old.mtu > mtu) throw new Error('MTU do bond excede uma NIC participante.');
  const used = new Set(e.state.devices.flatMap(v => v.interfaces.map(p => p.mac)));
  let suffix = number, mac = old?.mac;
  while (!mac) {
    const candidate = base.mac.split(':').slice(0,4).join(':') + ':07:' + suffix.toString(16).padStart(2,'0');
    if (!used.has(candidate)) mac = candidate;
    if (++suffix > 255 && !mac) throw new Error('Sem MAC disponível para o bond.');
  }
  const token = e.id('bond');
  const port = interfaceSchema.parse({ ... (old ?? base), id: old?.id ?? e.id('bond-port'), name: 'Bond'+number, mac, adminUp: old?.adminUp ?? true, mtu: old?.mtu ?? mtu,
    installedNic: undefined, qos: undefined, channel: undefined, spanningTree: undefined,
    bond: { number, members, primary, monitor: watched, startedAt: e.state.clock, nextProbeAt: e.state.clock, health: members.map(port => ({port})), token, tickAt: e.state.clock + 100, announcements: 0, announceAt: e.state.clock }, rx: old?.rx ?? 0, tx: old?.tx ?? 0, errors: old?.errors ?? 0,
  });
  for (const p of d.interfaces) if (old && p.channel === old.id) delete p.channel;
  for (const p of physical) {
    p!.channel = port.id;
    delete p!.ip; delete p!.prefix; delete p!.ipv4Mode; delete p!.gateway; delete p!.dns;
  }
  d.interfaces = [...d.interfaces.filter(p => p !== old), port];
  e.state.queue = e.state.queue.filter(q => q.action.kind !== 'bond-tick' || q.action.device !== d.id || q.action.port !== port.id);
  e.schedule(100, {kind:'bond-tick', device:d.id, port:port.id, token});
  invalidateProtocolIndex(e.state);
  e.emit('CONFIG_CHANGED', d.id, `${port.name}: ativo/backup, ${members.length} NICs; primária ${primary}.`, {port:port.id});
  refreshBonds(e);
  return port;
}
function announce(e: SimulationEngine, d: Device, p: NetworkInterface) {
  if (p.ip) e.sendFrame(d.id,p.id,{src:p.mac,dst:BROADCAST,etherType:'ARP',hops:LIMITS.l2Hops,arp:{kind:'request',senderIp:p.ip,senderMac:p.mac,targetIp:p.ip}});
  for (const a of p.ipv6?.addresses.filter(a => a.state === 'preferred' || a.state === 'deprecated') ?? [])
    frame6(e,d,p,{protocol:'ICMPv6',kind:'na',src:a.ip,dst:'ff02::1',target:a.ip,mac:p.mac,hopLimit:255,bytes:72,solicited:false,override:true,router:false});
}
export function refreshBonds(e: SimulationEngine) {
  for (const d of protocolDevices(e.state,'bond')) for (const p of d.interfaces.filter(p => p.bond)) {
    const b=p.bond!, active=bondActive(e.state,d,p);
    if (active === b.active) continue;
    b.active=active;
    b.announcements=active ? 3 : 0;
    b.announceAt=e.state.clock;
    e.emit('BOND_STATE_CHANGED',d.id,`${p.name}: ${active ? 'NIC ativa '+active : 'nenhum caminho disponível'}.`,{port:p.id});
    if(active) { announce(e,d,p); b.announcements--; b.announceAt=e.state.clock+200; }
  }
}
export function bondOutput(e: SimulationEngine,d:Device,p:NetworkInterface,frame:Frame) {
  const active=bondActive(e.state,d,p);
  if (!active) { e.drop(d,'Bond: nenhum caminho ativo.',p.id,frame); return; }
  p.tx++;
  e.sendFrame(d.id,active,frame);
}
export function receiveBondProbe(e:SimulationEngine,d:Device,member:NetworkInterface,frame:Frame) {
  const port=d.interfaces.find(p=>p.id===member.channel), b=port?.bond, arp=frame.arp;
  if (!b?.monitor || !arp || arp.kind!=='reply' || arp.senderIp!==b.monitor.target || arp.targetIp!=='0.0.0.0' || frame.dst!==member.mac || arp.senderMac!==frame.src) return false;
  b.health.find(h=>h.port===member.id)!.lastResponseAt=e.state.clock;
  refreshBonds(e);
  return true;
}
export function handleBondTick(e:SimulationEngine,a:Extract<Action,{kind:'bond-tick'}>) {
  const d=e.device(a.device), p=d.interfaces.find(p=>p.id===a.port), b=p?.bond;
  if (!p || !b || b.token!==a.token || b.tickAt!==e.state.clock) return;
  refreshBonds(e);
  if (b.active && b.announcements && b.announceAt<=e.state.clock) {
    announce(e,d,p); b.announcements--; b.announceAt=e.state.clock+1000;
  }
  if (b.monitor && d.power && p.adminUp && b.nextProbeAt<=e.state.clock) {
    for (const id of b.members) {
      const member=d.interfaces.find(m=>m.id===id)!;
      if (!member.adminUp || !linksAt(e.state,d.id,id).some(l=>linkOperational(e.state,l))) continue;
      e.sendFrame(d.id,id,{src:member.mac,dst:BROADCAST,etherType:'ARP',hops:LIMITS.l2Hops,arp:{kind:'request',senderIp:'0.0.0.0',senderMac:member.mac,targetIp:b.monitor.target}});
    }
    b.nextProbeAt=e.state.clock+b.monitor.intervalMs;
  }
  b.tickAt=e.state.clock+100;
  e.schedule(100,a);
}
export function removeBond(e:SimulationEngine,d:Device,p:NetworkInterface) {
  if (!p.bond) throw new Error('Bond inexistente.');
  if (p.ip || p.ipv6 || p.dhcp || p.dhcp6 || p.vrf || p.aclIn || p.aclOut || d.dhcpServer?.pools.some(pool=>pool.port===p.id) || d.dhcp6Server?.pools.some(pool=>pool.port===p.id)) throw new Error('Remova endereços, serviços e políticas antes de dissolver o bond.');
  for (const m of d.interfaces) if(m.channel===p.id) delete m.channel;
  d.interfaces=d.interfaces.filter(m=>m!==p);
  d.arpTable=d.arpTable.filter(v=>v.port!==p.id);
  e.state.queue=e.state.queue.filter(q=>q.action.kind!=='bond-tick'||q.action.device!==d.id||q.action.port!==p.id);
  e.emit('CONFIG_CHANGED',d.id,'Bond dissolvido; NICs disponíveis.');
}
export function validateBonds(s:Snapshot) {
  const used=new Set<object>();
  for (const d of s.devices) for (const p of d.interfaces) {
    if (p.installedNic && (!['pc','server'].includes(d.type)||p.media!=='rj45'||p.bond||p.aggregate||p.logical||p.loopback)) throw new Error('NIC adicional incompatível.');
    const b=p.bond;
    if (!b) continue;
    if (!['pc','server'].includes(d.type)||p.logical||p.aggregate||p.channel||p.mode!=='routed'||new Set(b.members).size!==b.members.length||!b.members.includes(b.primary)||d.interfaces.some(v=>v!==p&&v.bond?.number===b.number)||s.links.some(l=>[l.a,l.b].some(end=>end.device===d.id&&end.port===p.id))) throw new Error('Bond inválido/duplicado.');
    for (const id of b.members) {
      const m=d.interfaces.find(m=>m.id===id);
      if (!m||m.channel!==p.id||m.bond||m.aggregate||m.logical||m.tunnel||m.vxlan||m.ip||m.ipv6||m.dhcp||m.dhcp6||m.vrf||m.aclIn||m.aclOut||m.dot1x||m.supplicant||m.mode!=='routed'||m.duplex!=='full'||!['rj45','sfp','qsfp'].includes(m.media)||m.mtu<p.mtu) throw new Error('Membro de bond incompatível.');
    }
    if (b.startedAt>s.clock||b.active!==bondActive(s,d,p)||b.health.length!==b.members.length||new Set(b.health.map(h=>h.port)).size!==b.health.length||b.health.some(h=>!b.members.includes(h.port)||(h.lastResponseAt??0)>s.clock)||(b.monitor&&!isUnicast(b.monitor.target))) throw new Error('Estado de bond inconsistente.');
    const timers=s.queue.filter(q=>q.action.kind==='bond-tick'&&q.action.device===d.id&&q.action.port===p.id);
    if(timers.length!==1||timers[0].at!==b.tickAt||b.tickAt<s.clock||timers[0].action.kind!=='bond-tick'||timers[0].action.token!==b.token) throw new Error('Timer de bond inconsistente.');
    used.add(timers[0].action);
  }
  for(const q of s.queue) if(q.action.kind==='bond-tick'&&!used.has(q.action)) throw new Error('Timer de bond órfão.');
}
