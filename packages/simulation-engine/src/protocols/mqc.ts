import type { Device, Snapshot, NetworkInterface } from '../model';
import type { SimulationEngine } from '../core/engine';
import { qosConfig } from './qos';
import { qosConfigSchema,qosClassSchema } from './qos-model';
import type {z} from 'zod';
export function mqc(d: Device) {
  return (d.mqc ??= { classMaps: [], policyMaps: [], attachments: [] });
}
type Policy = NonNullable<Device['mqc']>['policyMaps'][number];
function policyConfig(d: Device, p: NetworkInterface, policy: Policy) {
  type Class=z.infer<typeof qosClassSchema>;
  const root=policy.classes.length===1&&policy.classes[0].name==='class-default'?policy.classes[0]:undefined,rateMbps=root?.shapeMbps??p.speed,classes:Class[]=[];
  const walk=(node:Policy,ancestors:string[],groups:NonNullable<Class['groups']>,shapes:NonNullable<Class['shapePaths']>,policers:NonNullable<Class['policePaths']>,parentShare:number,parentRate:number,parentMark?:number,parentPriority=0,trail:string[]=[])=>{
    if(ancestors.includes(node.name)||ancestors.length>=4)throw new Error('Cyclic or excessive MQC hierarchy.');
    const ordered=[...node.classes.filter(c=>c.name!=='class-default'),node.classes.find(c=>c.name==='class-default')??{name:'class-default'}],reserved=node.classes.reduce((n,c)=>n+(c.priorityPercent??0)+(c.bandwidthPercent??0),0),remaining=100-reserved,remPercent=node.classes.reduce((n,c)=>n+(c.bandwidthRemainingPercent??0),0),unassigned=ordered.filter(c=>c.priorityPercent===undefined&&c.bandwidthPercent===undefined&&c.bandwidthRemainingPercent===undefined).length;
    for(const c of ordered){
      const cm=d.mqc!.classMaps.find(m=>m.name===c.name);if(c.name!=='class-default'&&!cm)throw new Error('Class-map does not exist: '+c.name);
      const path=[...trail,node.name,c.name].join('__'),name=ancestors.length?path:c.name,group={matchAny:cm?.matchAny??true,matches:c.name==='class-default'?[]:cm!.matches.length?cm!.matches:[{dscps:[]}]},allGroups=[...groups,group],rootShaper=node===policy&&root===c,allShapes=[...shapes,...(c.shapeMbps&&!rootShaper?[{name:path,rateMbps:c.shapeMbps,burst:Math.max(1500,Math.min(1048576,Math.ceil(c.shapeMbps*125*25)))}]:[])],allPolicers=[...policers,...(c.policeMbps?[{name:path,rateMbps:c.policeMbps,burst:65536}]:[])],local=c.priorityPercent??c.bandwidthPercent??(c.bandwidthRemainingPercent!==undefined?remaining*c.bandwidthRemainingPercent/100:remaining*(100-remPercent)/100/Math.max(1,unassigned)),share=Math.max(0.000001,parentShare*local/100),rate=Math.min(parentRate,c.shapeMbps??parentRate),mark=c.mark??parentMark,priority=c.priorityPercent?7:parentPriority;
      if(c.childPolicy){const child=d.mqc!.policyMaps.find(n=>n.name===c.childPolicy);if(!child)throw new Error('Child policy does not exist: '+c.childPolicy);walk(child,[...ancestors,node.name],allGroups,allShapes,allPolicers,share,rate,mark,priority,[...trail,node.name,c.name]);}
      else classes.push(qosClassSchema.parse({name,protocol:'any',priority,weight:1,share,mark,queueLimit:c.queueLimit,llqMbps:c.priorityPercent?parentRate*c.priorityPercent/100:undefined,burst:65536,groups:allGroups,shapePaths:allShapes,policePaths:allPolicers}));
      if(classes.length>64)throw new Error('Policy exceeds 64 leaf queues.');
    }
  };
  walk(policy,[],[],[],[],100,rateMbps);
  return qosConfigSchema.parse({
    enabled: true,
    rateMbps,
    queueLimit: root?.queueLimit ?? 256,
    scheduler: 'llq-cbwfq',
    classes,
  });
}
export function compileMqc(e: SimulationEngine, d: Device) {
  for (const a of d.mqc?.attachments ?? []) {
    const p = d.interfaces.find((p) => p.id === a.port),
      policy = d.mqc!.policyMaps.find((q) => q.name === a.policy);
    if (!p || !policy) throw new Error('Invalid service-policy attachment.');
    const direction=a.direction??'out';
    if(direction==='in'){const visit=(v:Policy,stack:string[])=>{if(stack.includes(v.name))throw new Error('Cyclic policy hierarchy.');for(const c of v.classes){if(c.shapeMbps!==undefined||c.priorityPercent!==undefined||c.bandwidthPercent!==undefined||c.bandwidthRemainingPercent!==undefined||c.queueLimit!==undefined)throw new Error('Input policies support classification, marking and policing; queuing belongs on output.');const child=d.mqc!.policyMaps.find(v=>v.name===c.childPolicy);if(child)visit(child,[...stack,v.name]);}};visit(policy,[]);}
    e.configureQos(d.id, p.id, policyConfig(d, p, policy),direction);
  }
}
export function detachMqc(e: SimulationEngine, d: Device, port: string,direction:'in'|'out'='out') {
  const s = mqc(d),
    p = d.interfaces.find((p) => p.id === port)!;
  const selector=direction==='out'?'qos':'ingressQos';
  s.attachments = s.attachments.filter((a) => a.port !== port||(a.direction??'out')!==direction);
  if (p[selector]) {
    e.configureQos(d.id, p.id, { ...qosConfig(p,direction), enabled: false },direction);
    delete p[selector];
  }
}
export function validateMqc(s: Snapshot) {
  for (const d of s.devices) {
    const q = d.mqc;
    if (!q) continue;
    if (
      new Set(q.classMaps.map((c) => c.name)).size !== q.classMaps.length ||
      new Set(q.policyMaps.map((c) => c.name)).size !== q.policyMaps.length ||
      new Set(q.attachments.map((a) => a.port+':'+(a.direction??'out'))).size !== q.attachments.length ||
      q.attachments.some(
        (a) => !d.interfaces.some((p) => p.id === a.port) || !q.policyMaps.some((p) => p.name === a.policy)
      )
    )
      throw new Error('Invalid MQC policy.');
    for (const policy of q.policyMaps) {
      const visit=(node:Policy,stack:string[])=>{if(stack.includes(node.name)||stack.length>=4)throw new Error('Cyclic or excessive MQC hierarchy.');for(const c of node.classes){const child=q.policyMaps.find(p=>p.name===c.childPolicy);if(child)visit(child,[...stack,node.name]);}};visit(policy,[]);
      if (
        new Set(policy.classes.map((c) => c.name)).size !== policy.classes.length ||
        policy.classes.some(
          (c) =>
            (c.name !== 'class-default' && !q.classMaps.some((m) => m.name === c.name)) ||
            [c.priorityPercent, c.bandwidthPercent, c.bandwidthRemainingPercent].filter(
              (v) => v !== undefined
            ).length > 1 ||
            (c.childPolicy!==undefined&&!q.policyMaps.some(p=>p.name===c.childPolicy)) ||
            (c.childPolicy!==undefined&&c.queueLimit!==undefined)
        ) ||
        policy.classes.reduce((n, c) => n + (c.priorityPercent ?? 0) + (c.bandwidthPercent ?? 0), 0) > 100 ||
        policy.classes.reduce((n, c) => n + (c.bandwidthRemainingPercent ?? 0), 0) > 100
      )
        throw new Error('Invalid MQC class allocation.');
    }
    for (const a of q.attachments) {
      const p = d.interfaces.find((p) => p.id === a.port)!;
      if (
        !(a.direction==='in'?p.ingressQos:p.qos) ||
        JSON.stringify(
          policyConfig(
            d,
            p,
            q.policyMaps.find((p) => p.name === a.policy)!
          )
        ) !== JSON.stringify(qosConfigSchema.parse(qosConfig(p,a.direction??'out')))
      )
        throw new Error('Service-policy and forwarding scheduler do not match.');
    }
  }
}
