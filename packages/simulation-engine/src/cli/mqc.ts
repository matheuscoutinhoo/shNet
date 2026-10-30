import type { Device } from '../model';
import { mqc, compileMqc, detachMqc } from '../protocols/mqc';
import { ALL_MODES, currentPort, type CommandRegistry } from './registry';
export const dscpNumber = (v: string) => {
  const names: Record<string, number> = {
    default: 0,
    ef: 46,
    cs0: 0,
    cs1: 8,
    cs2: 16,
    cs3: 24,
    cs4: 32,
    cs5: 40,
    cs6: 48,
    cs7: 56,
  };
  const af = /^af([1-4])([1-3])$/i.exec(v);
  const n = names[v.toLowerCase()] ?? (af ? Number(af[1]) * 8 + Number(af[2]) * 2 : Number(v));
  if (!Number.isInteger(n) || n < 0 || n > 63) throw new Error('Invalid DSCP.');
  return n;
};
export function registerMqc(r: CommandRegistry) {
  r.register({pattern:/^(no )?match access-group(?: name)? ([\w-]{1,32})$/i,modes:['class-map'],run:(m,e,d,c)=>{const cm=mqc(d).classMaps.find(x=>x.name===c.name)!;cm.matches=[...cm.matches.filter(v=>v.acl!==m[2]),...(m[1]?[]:[{acl:m[2]}])];compileMqc(e,d);}});
  r.register({pattern:/^no match (?:ip )?dscp(?: (.+))?$/i,modes:['class-map'],run:(_m,e,d,c)=>{const cm=mqc(d).classMaps.find(x=>x.name===c.name)!;cm.matches=cm.matches.filter(v=>v.dscps===undefined&&v.dscp===undefined);compileMqc(e,d);}});
  r.register({pattern:/^no match protocol (icmp|tcp|udp)$/i,modes:['class-map'],run:(m,e,d,c)=>{const cm=mqc(d).classMaps.find(x=>x.name===c.name)!;cm.matches=cm.matches.filter(v=>v.protocol!==m[1].toLowerCase());compileMqc(e,d);}});
  r.register({pattern:/^no (priority percent|bandwidth percent|bandwidth remaining percent|police|shape average|queue-limit|set dscp)$/i,modes:['policy-class'],run:(m,e,d,c)=>{const cl=mqc(d).policyMaps.find(x=>x.name===c.name)!.classes.find(x=>x.name===c.className)!;const field={'priority percent':'priorityPercent','bandwidth percent':'bandwidthPercent','bandwidth remaining percent':'bandwidthRemainingPercent',police:'policeMbps','shape average':'shapeMbps','queue-limit':'queueLimit','set dscp':'mark'} as const;delete cl[field[m[1].toLowerCase() as keyof typeof field]];compileMqc(e,d);}});
  r.register({pattern:/^no class ([\w-]{1,32})$/i,modes:['policy-map'],run:(m,e,d,c)=>{const p=mqc(d).policyMaps.find(p=>p.name===c.name)!;p.classes=p.classes.filter(v=>v.name!==m[1]);compileMqc(e,d);}});
  r.register({pattern:/^no class-map ([\w-]{1,32})$/i,modes:['config'],run:(m,e,d)=>{const s=mqc(d);if(s.policyMaps.some(p=>p.classes.some(c=>c.name===m[1])))throw new Error('Class-map is referenced by a policy.');s.classMaps=s.classMaps.filter(v=>v.name!==m[1]);compileMqc(e,d);}});
  r.register({pattern:/^no policy-map ([\w-]{1,32})$/i,modes:['config'],run:(m,e,d)=>{const s=mqc(d);if(s.attachments.some(a=>a.policy===m[1])||s.policyMaps.some(p=>p.classes.some(c=>c.childPolicy===m[1])))throw new Error('Policy-map is attached or referenced.');s.policyMaps=s.policyMaps.filter(p=>p.name!==m[1]);compileMqc(e,d);}});
  r.register({pattern:/^(no )?service-policy ([\w-]{1,32})$/i,modes:['policy-class'],run:(m,e,d,c)=>{const cl=mqc(d).policyMaps.find(p=>p.name===c.name)!.classes.find(p=>p.name===c.className)!;cl.childPolicy=m[1]?undefined:m[2];compileMqc(e,d);}});
  r.register({
    pattern: /^class-map(?: (match-any|match-all))? ([\w-]{1,32})$/i,
    modes: ['config'],
    run: (m, _e, d, c) => {
      const s = mqc(d);
      let cm = s.classMaps.find((x) => x.name === m[2]);
      if (!cm) {
        cm = { name: m[2], matchAny: m[1]?.toLowerCase() === 'match-any', matches: [] };
        s.classMaps.push(cm);
      }
      else if(m[1])cm.matchAny=m[1].toLowerCase()==='match-any';
      compileMqc(_e,d);
      c.mode = 'class-map';
      c.name = cm.name;
    },
  });
  r.register({
    pattern: /^match(?: ip)? dscp ([\w ]+)$/i,
    modes: ['class-map'],
    run: (m, e, d, c) => {
      const cm = mqc(d).classMaps.find((x) => x.name === c.name)!;
      cm.matches=[...cm.matches.filter(v=>v.dscps===undefined&&v.dscp===undefined),{ dscps: m[1].trim().split(/\s+/).map(dscpNumber) }];
      compileMqc(e, d);
    },
  });
  r.register({
    pattern: /^match protocol (icmp|tcp|udp)$/i,
    modes: ['class-map'],
    run: (m, e, d, c) => {
      mqc(d)
        .classMaps.find((x) => x.name === c.name)!
        .matches.push({ protocol: m[1].toLowerCase() as 'icmp' | 'tcp' | 'udp' });
      compileMqc(e, d);
    },
  });
  r.register({
    pattern: /^policy-map ([\w-]{1,32})$/i,
    modes: ['config'],
    run: (m, _e, d, c) => {
      const s = mqc(d);
      if (!s.policyMaps.some((x) => x.name === m[1])) s.policyMaps.push({ name: m[1], classes: [] });
      c.mode = 'policy-map';
      c.name = m[1];
    },
  });
  r.register({
    pattern: /^class ([\w-]{1,32})$/i,
    modes: ['policy-map'],
    run: (m, _e, d, c) => {
      const policy = mqc(d).policyMaps.find((x) => x.name === c.name)!;
      if (m[1] !== 'class-default' && !d.mqc!.classMaps.some((x) => x.name === m[1]))
        throw new Error('Class-map not configured.');
      if (!policy.classes.some((x) => x.name === m[1])) policy.classes.push({ name: m[1] });
      c.mode = 'policy-class';
      c.className = m[1];
    },
  });
  r.register({
    pattern:
      /^(priority percent|bandwidth percent|bandwidth remaining percent|police|shape average|queue-limit|set dscp) (\S+)$/i,
    modes: ['policy-class'],
    run: (m, e, d, c) => {
      const cl = mqc(d)
        .policyMaps.find((x) => x.name === c.name)!
        .classes.find((x) => x.name === c.className)!;
      const field = m[1].toLowerCase(),
        n = Number(m[2]);
      if (field === 'set dscp') cl.mark = dscpNumber(m[2]);
      else if (field === 'priority percent') cl.priorityPercent = n;
      else if (field === 'bandwidth remaining percent') cl.bandwidthRemainingPercent = n;
      else if (field === 'bandwidth percent') cl.bandwidthPercent = n;
      else if (field === 'police') cl.policeMbps = n / 1e6;
      else if (field === 'shape average') cl.shapeMbps = n / 1e6;
      else cl.queueLimit = n;
      compileMqc(e, d);
    },
  });
  r.register({
    pattern: /^(no )?service-policy (input|output) ([\w-]{1,32})$/i,
    modes: ['interface'],
    run: (m, e, d, c) => {
      const p = currentPort(d, c);
      const direction=m[2].toLowerCase()==='input'?'in':'out';
      if (m[1]) {
        if(!d.mqc?.attachments.some(a=>a.port===p.id&&(a.direction??'out')===direction&&a.policy===m[3]))throw new Error('The named service-policy is not attached in this direction.');
        detachMqc(e, d, p.id,direction);
        return;
      }
      const s = mqc(d);
      if (!s.policyMaps.some((x) => x.name === m[3])) throw new Error('Policy-map not configured.');
      s.attachments = [...s.attachments.filter((a) => a.port !== p.id||(a.direction??'out')!==direction), { port: p.id, policy: m[3],direction }];
      compileMqc(e, d);
    },
  });
  r.register({
    pattern: /^show policy-map(?: interface (\S+))?$/i,
    modes: ALL_MODES,
    run: (_m, _e, d) =>
      JSON.stringify(
        {
          policies: d.mqc?.policyMaps,
          interfaces: d.interfaces
            .filter((p) => p.qos)
            .map((p) => ({ name: p.name, rateMbps: p.qos!.rateMbps, stats: p.qos!.stats })),
        },
        null,
        2
      ),
  });
}
export function mqcDefinitions(d: Device) {
  return [
    ...(d.mqc?.classMaps ?? []).flatMap((c) => [
      `class-map ${c.matchAny ? 'match-any' : 'match-all'} ${c.name}`,
      ...c.matches.flatMap((m) => [
        ...(m.protocol ? [' match protocol ' + m.protocol] : []),
        ...(m.dscp !== undefined ? [' match ip dscp ' + m.dscp] : []),
        ...(m.dscps?.length ? [' match ip dscp ' + m.dscps.join(' ')] : []),
        ...(m.acl?[' match access-group name '+m.acl]:[]),
      ]),
      'exit',
    ]),
    ...orderedPolicies(d).flatMap((p) => [
      'policy-map ' + p.name,
      ...p.classes.flatMap((c) => [
        ' class ' + c.name,
        ...(c.priorityPercent ? ['  priority percent ' + c.priorityPercent] : []),
        ...(c.bandwidthPercent ? ['  bandwidth percent ' + c.bandwidthPercent] : []),
        ...(c.bandwidthRemainingPercent
          ? ['  bandwidth remaining percent ' + c.bandwidthRemainingPercent]
          : []),
        ...(c.policeMbps ? ['  police ' + c.policeMbps * 1e6] : []),
        ...(c.shapeMbps ? ['  shape average ' + c.shapeMbps * 1e6] : []),
        ...(c.queueLimit ? ['  queue-limit ' + c.queueLimit] : []),
        ...(c.mark !== undefined ? ['  set dscp ' + c.mark] : []),
        ...(c.childPolicy?['  service-policy '+c.childPolicy]:[]),
        ' exit',
      ]),
      'exit',
    ]),
  ];
}
function orderedPolicies(d:Device){const result:NonNullable<Device['mqc']>['policyMaps']=[],seen=new Set<string>();const visit=(p:typeof result[number],stack:string[])=>{if(stack.includes(p.name))throw new Error('Cyclic policy hierarchy.');if(seen.has(p.name))return;for(const c of p.classes){const child=d.mqc?.policyMaps.find(v=>v.name===c.childPolicy);if(child)visit(child,[...stack,p.name]);}seen.add(p.name);result.push(p);};for(const p of d.mqc?.policyMaps??[])visit(p,[]);return result;}
export function mqcAttachments(d: Device) {
  return (d.mqc?.attachments ?? []).flatMap((a) => [
    'interface ' + d.interfaces.find((p) => p.id === a.port)!.name,
    ' service-policy '+(a.direction==='in'?'input':'output')+' ' + a.policy,
    'exit',
  ]);
}
