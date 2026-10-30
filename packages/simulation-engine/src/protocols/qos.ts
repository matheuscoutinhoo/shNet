import type { SimulationEngine } from '../core/engine';
import {
  frameSchema,
  type Action,
  type Device,
  type Frame,
  type NetworkInterface,
  type Snapshot,
} from '../model';
import { qosConfigSchema } from './qos-model';
import {qosMatches,qosFrameBytes} from './qos-classify';
export function qosConfig(p: NetworkInterface,direction:'in'|'out'='out') {
  const q = direction==='out'?p.qos:p.ingressQos;
  return q
    ? {
        enabled: q.enabled,
        rateMbps: q.rateMbps,
        queueLimit: q.queueLimit,
        ...(q.ecnThreshold ? { ecnThreshold: q.ecnThreshold } : {}),
        scheduler: q.scheduler,
        classes: q.classes,
      }
    : { enabled: true, rateMbps: p.speed, queueLimit: 64, scheduler: 'priority' as const, classes: [] };
}
export function configureQos(e: SimulationEngine, d: Device, p: NetworkInterface, input: unknown,direction:'in'|'out'='out') {
  const selector=direction==='out'?'qos':'ingressQos';
  const c = qosConfigSchema.parse(input);
  if (
    p.logical ||
    p.aggregate ||
    p.bond ||
    p.tunnel ||
    p.vxlan ||
    p.media === 'wifi' ||
    c.rateMbps > p.speed ||
    (c.ecnThreshold !== undefined && c.ecnThreshold > c.queueLimit) ||
    c.classes.some((c) => c.name === 'default') ||
    new Set(c.classes.map((p) => p.name)).size !== c.classes.length
  )
    throw new Error('QoS exige porta física cabeada, taxa até a velocidade e classes únicas.');
  for (const queued of p[selector]?.queues ?? [])
    e.drop(
      d,
      'QoS: reconfiguração removeu frame pendente.',
      p.id,
      frameSchema.parse(JSON.parse(queued.frame))
    );
  p[selector] = {
    ...c,
    token: e.id('qos'),
    cursor: 0,
    remaining: 0,
    queues: [],
    virtualTime:0,
    buckets:[...new Map(c.classes.flatMap(r=>[...(r.shapePaths??[]).map(b=>({...b,kind:'shape' as const})),...(r.policePaths??[]).map(b=>({...b,kind:'police' as const}))]).map(b=>[b.kind+':'+b.name,{name:b.name,kind:b.kind,tokens:b.burst,updatedAt:e.state.clock}])).values()],
    stats: [...c.classes.map((c) => ({ name: c.name, burst: c.burst })), { name: 'default', burst: 0 }].map(
      (c) => ({
        name: c.name,
        enqueued: 0,
        dequeued: 0,
        dropped: 0,
        bytes: 0,
        tokens: c.burst,
        updatedAt: e.state.clock,
      })
    ),
  };
  if(direction==='out')e.state.queue = e.state.queue.filter(
    ({ action: a }) => a.kind !== 'qos-tick' || a.device !== d.id || a.port !== p.id
  );
  e.emit('CONFIG_CHANGED', d.id, 'QoS ' + c.scheduler + ' ' + c.rateMbps + ' Mbps em ' + p.name + '.', {
    port: p.id,
  });
}
export function enqueueQos(e: SimulationEngine, d: Device, p: NetworkInterface, frame: Frame, link: string) {
  const q = p.qos;
  if (!q?.enabled) return false;
  const packet = frame.packet ?? frame.ipv6 ?? frame.fragment,
    rule = q.classes.find(c=>qosMatches(c,frame,d)),
    name = rule?.name ?? 'default',
    stats = q.stats.find((s) => s.name === name)!,
    bytes = qosFrameBytes(frame);
  const policing = rule?.policeMbps ?? (q.queues.length ? rule?.llqMbps : undefined);
  for(const path of rule?.policePaths??[]){const bucket=q.buckets!.find(b=>b.kind==='police'&&b.name===path.name)!;bucket.tokens=Math.min(path.burst,bucket.tokens+(e.state.clock-bucket.updatedAt)*path.rateMbps*125);bucket.updatedAt=e.state.clock;if(bucket.tokens<bytes){stats.dropped++;e.emit('QOS_DROP',d.id,'Policer '+path.name+': insufficient tokens.',{port:p.id,frame});e.drop(d,'QoS policer '+path.name,p.id,frame);return true;}}
  for(const path of rule?.policePaths??[])q.buckets!.find(b=>b.kind==='police'&&b.name===path.name)!.tokens-=bytes;
  if (rule && policing !== undefined) {
    stats.tokens = Math.min(rule.burst, stats.tokens + (e.state.clock - stats.updatedAt) * policing * 125);
    stats.updatedAt = e.state.clock;
    if (stats.tokens < bytes) {
      stats.dropped++;
      e.emit('QOS_DROP', d.id, 'Policer ' + name + ': orçamento de tokens insuficiente.', {
        port: p.id,
        frame,
      });
      e.drop(d, 'QoS policer ' + name + '.', p.id, frame);
      return true;
    }
    stats.tokens -= bytes;
  }
  if (q.queues.length >= q.queueLimit || (rule?.queueLimit!==undefined&&q.queues.filter(f=>f.class===name).length>=rule.queueLimit)) {
    stats.dropped++;
    e.emit('QOS_DROP', d.id, 'QoS tail drop: fila cheia (' + q.queueLimit + ').', { port: p.id, frame });
    e.drop(d, 'QoS congestionamento.', p.id, frame);
    return true;
  }
  const tcp =
    frame.packet?.protocol === 'TCP'
      ? frame.packet
      : frame.ipv6?.protocol === 'TCP'
        ? frame.ipv6.segment
        : undefined;
  if (tcp?.data && tcp.ecn && q.ecnThreshold !== undefined && q.queues.length >= q.ecnThreshold) {
    tcp.ecn = 3;
    e.emit('QOS_MARK', d.id, 'ECN: congestionamento sinalizado por CE.', { port: p.id, frame });
  }
  if (rule?.mark !== undefined && packet) {
    packet.dscp = rule.mark;
    e.emit('QOS_MARK', d.id, name + ': DSCP ' + rule.mark + '.', { port: p.id, frame });
  }
  if (rule?.markTc !== undefined && frame.mpls) {
    frame.mpls.labels[0].tc = rule.markTc;
    e.emit('QOS_MARK', d.id, name + ': MPLS TC ' + rule.markTc + '.', { port: p.id, frame });
  }
  q.queues.push({
    class: name,
    frame: JSON.stringify(frameSchema.parse(frame)),
    bytes,
    at: e.state.clock,
    link,
    ...(q.scheduler==='llq-cbwfq'?{finish:Math.max(q.virtualTime??0,stats.lastFinish??0)+bytes/(rule?.share??1)}:{}),
  });
  if(q.scheduler==='llq-cbwfq')stats.lastFinish=q.queues.at(-1)!.finish;
  stats.enqueued++;
  e.emit('QOS_ENQUEUE', d.id, name + ': ' + q.queues.length + ' frame(s) na fila.', { port: p.id, frame });
  if (q.timerAt === undefined) {
    q.timerAt = e.state.clock + 0.001;
    e.schedule(0.001, { kind: 'qos-tick', device: d.id, port: p.id, token: q.token });
  }
  return true;
}
export function handleQosTick(e: SimulationEngine, a: Extract<Action, { kind: 'qos-tick' }>) {
  const d = e.device(a.device),
    p = d.interfaces.find((p) => p.id === a.port)!,
    q = p.qos;
  if (!q || q.token !== a.token || q.timerAt !== e.state.clock) return;
  delete q.timerAt;
  if (!q.queues.length) return;
  const classes = [...q.classes, { name: 'default', priority: 0, weight: 1 }];
  let selectedIndex:number|undefined;
  if(q.scheduler==='llq-cbwfq'){
    let next=Infinity;const eligible:number[]=[];
    for(const [i,item]of q.queues.entries()){
      if(q.queues.findIndex(v=>v.class===item.class)!==i)continue;
      const rule=q.classes.find(c=>c.name===item.class);let wait=0;
      for(const path of rule?.shapePaths??[]){const bucket=q.buckets!.find(b=>b.kind==='shape'&&b.name===path.name)!;bucket.tokens=Math.min(Math.max(path.burst,item.bytes),bucket.tokens+(e.state.clock-bucket.updatedAt)*path.rateMbps*125);bucket.updatedAt=e.state.clock;wait=Math.max(wait,(item.bytes-bucket.tokens)/(path.rateMbps*125));}
      if(wait<=0)eligible.push(i);else next=Math.min(next,e.state.clock+wait);
    }
    if(!eligible.length){q.timerAt=Math.max(e.state.clock+0.001,next);e.scheduleAt(q.timerAt,{kind:'qos-tick',device:d.id,port:p.id,token:q.token});return;}
    eligible.sort((a,b)=>{const ra=q.classes.find(c=>c.name===q.queues[a].class),rb=q.classes.find(c=>c.name===q.queues[b].class);return (rb?.priority??0)-(ra?.priority??0)||(q.queues[a].finish??0)-(q.queues[b].finish??0)||a-b;});selectedIndex=eligible[0];
    const item=q.queues[selectedIndex],rule=q.classes.find(c=>c.name===item.class);for(const path of rule?.shapePaths??[])q.buckets!.find(b=>b.kind==='shape'&&b.name===path.name)!.tokens-=item.bytes;
    if(!rule?.priority)q.virtualTime=item.finish;
  }
  let name: string;
  if(selectedIndex!==undefined)name=q.queues[selectedIndex].class;
  else if (
    q.scheduler === 'priority' ||
    (q.scheduler === 'llq-wrr' &&
      classes.some((c) => c.priority > 0 && q.queues.some((f) => f.class === c.name)))
  ) {
    const nonempty = classes
      .filter((c) => q.queues.some((f) => f.class === c.name))
      .sort((a, b) => b.priority - a.priority);
    name = nonempty[0].name;
  } else {
    let selected = classes[q.cursor];
    for (let n = 0; n < classes.length; n++) {
      if (q.queues.some((f) => f.class === selected.name)) break;
      q.cursor = (q.cursor + 1) % classes.length;
      q.remaining = 0;
      selected = classes[q.cursor];
    }
    name = selected.name;
    if (q.remaining === 0) q.remaining = selected.weight;
    q.remaining--;
    if (q.remaining === 0) q.cursor = (q.cursor + 1) % classes.length;
  }
  const at = selectedIndex??q.queues.findIndex((f) => f.class === name),
    [item] = q.queues.splice(at, 1),
    frame = frameSchema.parse(JSON.parse(item.frame)),
    stats = q.stats.find((s) => s.name === name)!;
  stats.dequeued++;
  stats.bytes += item.bytes;
  e.emit('QOS_DEQUEUE', d.id, name + ': espera ' + (e.state.clock - item.at).toFixed(3) + ' ms.', {
    port: p.id,
    frame,
  });
  e.transmitQueued(d.id, p.id, frame, item.link);
  const delay = Math.max(0.001, (item.bytes * 8) / (Math.min(q.rateMbps, p.speed) * 1000));
  q.timerAt = e.state.clock + delay;
  e.schedule(delay, { kind: 'qos-tick', device: d.id, port: p.id, token: q.token });
}
export function validateQos(s: Snapshot) {
  const used = new Set<Action>();
  for (const d of s.devices)
    for (const p of d.interfaces)for(const direction of ['in','out'] as const) {
      const q = direction==='out'?p.qos:p.ingressQos;
      if (!q) continue;
      const names = [...q.classes.map((c) => c.name), 'default'];
      if (
        p.logical ||
        p.aggregate ||
        p.bond ||
        p.tunnel ||
        p.vxlan ||
        p.media === 'wifi' ||
        q.rateMbps > p.speed ||
        new Set(names).size !== names.length ||
        q.cursor >= names.length ||
        q.stats.length !== names.length ||
        new Set(q.stats.map((n) => n.name)).size !== names.length ||
        q.stats.some((n) => !names.includes(n.name) || n.updatedAt > s.clock) ||
        q.queues.length > q.queueLimit
      )
        throw new Error('Estado/configuração QoS inválido.');
      for (const f of q.queues) {
        const frame = frameSchema.parse(JSON.parse(f.frame));
        if (
          f.bytes !== qosFrameBytes(frame) ||
          !names.includes(f.class) ||
          f.at > s.clock ||
          (q.scheduler==='llq-cbwfq'&&f.finish===undefined)||
          !s.links.some(
            (l) => l.id === f.link && [l.a, l.b].some((end) => end.device === d.id && end.port === p.id)
          )
        )
          throw new Error('Frame na fila QoS inválido.');
      }
      const ticks = s.queue.filter(
        (v) => direction==='out'&&v.action.kind === 'qos-tick' && v.action.device === d.id && v.action.port === p.id
      );
      if (
        q.timerAt === undefined
          ? ticks.length > 0 || q.queues.length > 0
          : ticks.length !== 1 ||
            ticks[0].at !== q.timerAt ||
            (ticks[0].action as Extract<Action, { kind: 'qos-tick' }>).token !== q.token
      )
        throw new Error('Timer QoS inconsistente.');
      ticks.forEach((v) => used.add(v.action));
      const paths=[...new Map(q.classes.flatMap(c=>[...(c.shapePaths??[]).map(b=>({...b,kind:'shape' as const})),...(c.policePaths??[]).map(b=>({...b,kind:'police' as const}))]).map(b=>[b.kind+':'+b.name,b])).values()];
      if(paths.length!==(q.buckets?.length??0)||paths.some(path=>{const b=q.buckets?.find(b=>b.kind===path.kind&&b.name===path.name);return !b||b.updatedAt>s.clock||b.tokens>Math.max(path.burst,65600);}))throw new Error('Invalid hierarchical QoS token buckets.');
    }
  for (const v of s.queue)
    if (v.action.kind === 'qos-tick' && !used.has(v.action)) throw new Error('Timer QoS órfão.');
}
export function permitIngressQos(e:SimulationEngine,d:Device,p:NetworkInterface,frame:Frame){
 const q=p.ingressQos;if(!q?.enabled||!(frame.packet||frame.ipv6||frame.fragment||frame.mpls))return true;
 const rule=q.classes.find(c=>qosMatches(c,frame,d)),stats=q.stats.find(s=>s.name===(rule?.name??'default'))!,bytes=qosFrameBytes(frame);
 stats.enqueued++;
 for(const path of rule?.policePaths??[]){const b=q.buckets!.find(b=>b.name===path.name&&b.kind==='police')!;b.tokens=Math.min(path.burst,b.tokens+(e.state.clock-b.updatedAt)*path.rateMbps*125);b.updatedAt=e.state.clock;if(b.tokens<bytes){stats.dropped++;e.emit('QOS_DROP',d.id,'Input policer '+path.name+': insufficient tokens.',{port:p.id,frame});e.drop(d,'Input QoS policer '+path.name,p.id,frame);return false;}}
 for(const path of rule?.policePaths??[])q.buckets!.find(b=>b.name===path.name&&b.kind==='police')!.tokens-=bytes;
 const packet=frame.packet??frame.ipv6??frame.fragment;if(rule?.mark!==undefined&&packet){packet.dscp=rule.mark;e.emit('QOS_MARK',d.id,'Input DSCP '+rule.mark,{port:p.id,frame});}
 stats.dequeued++;stats.bytes+=bytes;return true;
}
