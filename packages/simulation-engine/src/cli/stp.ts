import { ALL_MODES, CONFIG_MODES, CommandRegistry, currentPort } from './registry';
import { bridgeId, bridgeLabel, portCost } from '../protocols/stp-election';
import type { Device } from '../model';
import { multiStpConfig,updateSpanningTreePort } from '../protocols/stp';
import { showSpanningTree } from './ios-show';

export function registerStpCommands(registry: CommandRegistry) {
  registry.register({pattern:/^(no )?spanning-tree guard (root|loop)$/i,modes:['interface'],run:(m,e,d,c)=>{
    const p=currentPort(d,c);if(p.mode==='routed'||p.logical)throw new Error('STP guards require a switchport.');if(m[1])delete p.stpGuard;else p.stpGuard=m[2].toLowerCase() as 'root'|'loop';updateSpanningTreePort(e,d,p);
  }});
  registry.register({pattern:/^(no )?spanning-tree loopguard default$/i,modes:CONFIG_MODES,run:(m,e,d)=>{d.loopGuardDefault=!m[1];for(const p of d.interfaces.filter(p=>p.mode!=='routed'))updateSpanningTreePort(e,d,p);}});
  registry.register({pattern:/^spanning-tree mst configuration$/i,modes:['config'],run:(_m,e,d,c)=>{
    const old=multiStpConfig(d);e.configureMultiSpanningTree(d.id,{...old,mode:'mstp',protocol:'rstp',mappings:old?.mode==='mstp'?old.mappings:[]});c.mode='mst';
  }});
  registry.register({pattern:/^name ([\w-]{1,32})$/i,modes:['mst'],run:(m,e,d)=>e.configureMultiSpanningTree(d.id,{...multiStpConfig(d),region:m[1]})});
  registry.register({pattern:/^revision (\d+)$/i,modes:['mst'],run:(m,e,d)=>e.configureMultiSpanningTree(d.id,{...multiStpConfig(d),revision:Number(m[1])})});
  registry.register({pattern:/^instance (\d+) vlan ([\d,-]+)$/i,modes:['mst'],run:(m,e,d)=>{
    const vlans=m[2].split(',').flatMap(s=>{const [a,b]=s.split('-').map(Number);if(a<1||(b??a)>4094||(b??a)<a)throw new Error('Invalid VLAN range.');return Array.from({length:(b??a)-a+1},(_,i)=>a+i);});
    const value=multiStpConfig(d)!;e.configureMultiSpanningTree(d.id,{...value,mappings:[...value.mappings.filter(v=>!vlans.includes(v.vlan)),...vlans.map(vlan=>({vlan,instance:Number(m[1])}))]});
  }});
  registry.register({pattern:/^spanning-tree mst (\d+) priority (\d+)$/i,modes:['config'],run:(m,e,d)=>{
    const value=multiStpConfig(d);if(value?.mode!=='mstp')throw new Error('Configure MST first.');e.configureMultiSpanningTree(d.id,{...value,priorities:[...value.priorities.filter(p=>p.instance!==Number(m[1])),{instance:Number(m[1]),priority:Number(m[2])}]});
  }});
  registry.register({
    pattern: /^spanning-tree configure (.+)$/i,
    modes: CONFIG_MODES,
    run: (match, engine, device) => engine.configureMultiSpanningTree(device.id, JSON.parse(match[1])),
  });
  registry.register({
    pattern: /^spanning-tree mode (stp|rstp|pvst|rapid-pvst|mst)$/i,
    syntax: [
      'spanning-tree mode pvst',
      'spanning-tree mode rapid-pvst',
      'spanning-tree mode mst',
      'spanning-tree mode stp',
      'spanning-tree mode rstp',
    ],
    modes: CONFIG_MODES,
    run: (match, engine, device) => {
      const mode = match[1].toLowerCase();
      if (mode === 'stp' || mode === 'rstp') engine.configureSpanningTree(device.id, mode);
      else
        engine.configureMultiSpanningTree(device.id, {
          ...(multiStpConfig(device) ?? {}),
          mode: mode === 'mst' ? 'mstp' : 'pvst',
          protocol: mode === 'pvst' ? 'stp' : 'rstp',
          ...(mode === 'mst' ? {} : { mappings: [] }),
        });
    },
  });
  registry.register({
    pattern: /^(no )?spanning-tree vlan ([\d,-]+)$/i,
    syntax: ['spanning-tree vlan <vlans>', 'no spanning-tree vlan <vlans>'],
    modes: CONFIG_MODES,
    run: (m, e, d) => {
      const ids = m[2].split(',').flatMap((part) => {
        const [a, b] = part.split('-').map(Number);
        if (a < 1 || a > 4094 || (b !== undefined && (b < a || b > 4094))) throw new Error('Invalid VLAN range');
        return Array.from({ length: (b ?? a) - a + 1 }, (_, i) => a + i);
      });
      const running = !!d.spanningTree?.enabled || !!d.multiSpanningTree;
      if (!m[1]) {
        if (!running)
          e.configureMultiSpanningTree(d.id, { mode: 'pvst', protocol: 'rstp', mappings: [], priorities: [] });
        return;
      }
      if (!running) return;
      // The simulator runs one spanning-tree process for all VLANs of a switch.
      if (!d.vlans.every((v) => ids.includes(v.id)))
        throw new Error('Per-VLAN spanning-tree disable is not supported; use no spanning-tree vlan 1-4094.');
      e.configureSpanningTree(d.id, 'off');
    },
  });
  registry.register({
    pattern: /^spanning-tree vlan ([\d,-]+) priority (\d+)$/i,
    syntax: 'spanning-tree vlan <vlans> priority <priority>',
    modes: CONFIG_MODES,
    run: (m, e, d) => {
      const ids = m[1].split(',').flatMap((part) => {
        const [a, b] = part.split('-').map(Number);
        if (a < 1 || a > 4094 || (b !== undefined && (b < a || b > 4094)))
          throw new Error('Invalid VLAN range');
        return Array.from({ length: (b ?? a) - a + 1 }, (_, i) => a + i);
      });
      const c = multiStpConfig(d);
      if (c?.mode === 'mstp') throw new Error('Use MST instance priority in MST mode.');
      e.configureMultiSpanningTree(d.id, {
        ...(c ?? { mode: 'pvst', protocol: 'rstp' }),
        priorities: [
          ...(c?.priorities ?? []).filter((p) => !ids.includes(p.instance)),
          ...ids.map((instance) => ({ instance, priority: Number(m[2]) })),
        ],
      });
    },
  });
  registry.register({
    pattern: /^(no )?spanning-tree bpduguard(?: (enable|disable))?$/i,
    syntax: [
      'spanning-tree bpduguard enable',
      'spanning-tree bpduguard disable',
      'no spanning-tree bpduguard',
    ],
    modes: ['interface'],
    run: (m, _e, d, c) => {
      const p = currentPort(d, c);
      if (p.mode === 'routed' || p.logical || p.loopback)
        throw new Error('BPDU Guard requires a Layer 2 interface.');
      p.bpduGuard = !m[1] && m[2]?.toLowerCase() !== 'disable';
    },
  });
  registry.register({
    pattern: /^no spanning-tree$/i,
    modes: CONFIG_MODES,
    run: (_match, engine, device) => engine.configureSpanningTree(device.id, 'off'),
  });
  registry.register({
    pattern: /^spanning-tree priority (\d+)$/i,
    modes: CONFIG_MODES,
    run: (match, engine, device) => {
      const config = multiStpConfig(device);
      if (config)
        engine.configureMultiSpanningTree(device.id, {
          ...config,
          priorities: [
            ...config.priorities.filter((p) => p.instance !== 0),
            { instance: 0, priority: Number(match[1]) },
          ],
        });
      else engine.configureSpanningTree(device.id, device.spanningTree?.mode ?? 'rstp', Number(match[1]));
    },
  });
  registry.register({
    pattern: /^(no )?spanning-tree portfast$/i,
    modes: ['interface'],
    run: (match, engine, device, context) =>
      engine.setSpanningTreePort(device.id, currentPort(device, context).id, { edge: !match[1] }),
  });
  registry.register({
    pattern: /^spanning-tree cost (\d+)$/i,
    modes: ['interface'],
    run: (match, engine, device, context) =>
      engine.setSpanningTreePort(device.id, currentPort(device, context).id, { cost: Number(match[1]) }),
  });
  registry.register({
    pattern: /^no spanning-tree cost$/i,
    modes: ['interface'],
    run: (_match, engine, device, context) =>
      engine.setSpanningTreePort(device.id, currentPort(device, context).id, { cost: undefined }),
  });
  registry.register({
    pattern: /^show spanning-tree(?: vlan (\d+))?$/i,
    syntax: ['show spanning-tree', 'show spanning-tree vlan <vlan>'],
    modes: ALL_MODES,
    run: (match, engine, device) =>
      showSpanningTree(engine, device, match[1] === undefined ? undefined : Number(match[1])),
  });
  registry.register({
    // Simulator detail view of one tree, including guard and boundary states.
    pattern: /^show spanning-tree instance (\d+)$/i,
    modes: ALL_MODES,
    run: (match, _engine, device) => {
      const instance = Number(match[1] ?? 0);
      const tree = instance
        ? device.multiSpanningTree?.instances.find((i) => i.id === instance)?.tree
        : device.spanningTree;
      if (!tree?.enabled) return 'Spanning tree desabilitado';
      return [
        (device.multiSpanningTree?.mode.toUpperCase() ?? 'Common Spanning Tree') +
          ' / ' +
          tree.mode.toUpperCase() +
          ' / instância ' +
          instance,
        ...(device.multiSpanningTree
          ? ['Instâncias: ' + device.multiSpanningTree.instances.map((i) => i.id).join(', ')]
          : []),
        'Bridge ID: ' + bridgeLabel(bridgeId(device)),
        'Root ID: ' + bridgeLabel(tree.root) + ' | cost ' + tree.cost,
        'Root port: ' + (device.interfaces.find((port) => port.id === tree.rootPort)?.name ?? 'local'),
        'PORT          ROLE         STATE        COST  EDGE',
        ...device.interfaces
          .filter((port) =>
            instance ? port.spanningInstances?.some((i) => i.id === instance) : port.spanningTree
          )
          .map((port) => {
            const state = instance
              ? port.spanningInstances!.find((i) => i.id === instance)!.state
              : port.spanningTree!;
            return (
              port.name.padEnd(14) +
              state.role.padEnd(13) +
              state.state.padEnd(13) +
              String(portCost(port)).padEnd(6) +
              (port.stpEdge ? 'yes' : 'no') +
              (port.mstBoundary ? ' boundary' : '')+(state.guardInconsistent?' '+state.guardInconsistent+'-inconsistent':'')
            );
          }),
      ].join('\n');
    },
  });
}
export function stpRunningConfig(device: Device) {
  const c = multiStpConfig(device);
  if (c) return iosStpLines(c) ?? ['spanning-tree configure ' + JSON.stringify(c)];
  if (device.spanningTree?.enabled)
    return [
      'spanning-tree mode ' + device.spanningTree.mode,
      'spanning-tree priority ' + device.spanningTree.priority,
    ];
  // Switches boot with Rapid PVST+, so a disabled spanning tree is explicit configuration.
  return device.type === 'switch' ? ['no spanning-tree vlan 1-4094'] : [];
}
function vlanRanges(ids: number[]) {
  const sorted = [...new Set(ids)].sort((a, b) => a - b),
    parts: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(j > i ? sorted[i] + '-' + sorted[j] : String(sorted[i]));
    i = j;
  }
  return parts.join(',');
}
/** IOS running-config form of PVST/MST; undefined when only the simulator JSON form is exact. */
function iosStpLines(c: NonNullable<ReturnType<typeof multiStpConfig>>) {
  const byPriority = new Map<number, number[]>();
  for (const p of c.priorities) byPriority.set(p.priority, [...(byPriority.get(p.priority) ?? []), p.instance]);
  if (c.mode === 'pvst') {
    if (c.mappings.length || c.priorities.some((p) => p.instance === 0)) return undefined;
    return [
      'spanning-tree mode ' + (c.protocol === 'stp' ? 'pvst' : 'rapid-pvst'),
      ...[...byPriority].map(([priority, vlans]) => 'spanning-tree vlan ' + vlanRanges(vlans) + ' priority ' + priority),
    ];
  }
  if (c.protocol === 'stp' || !/^[\w-]{1,32}$/.test(c.region)) return undefined;
  const instances = new Map<number, number[]>();
  for (const m of c.mappings) instances.set(m.instance, [...(instances.get(m.instance) ?? []), m.vlan]);
  return [
    'spanning-tree mode mst',
    'spanning-tree mst configuration',
    ' name ' + c.region,
    ' revision ' + c.revision,
    ...[...instances]
      .sort(([a], [b]) => a - b)
      .map(([instance, vlans]) => ' instance ' + instance + ' vlan ' + vlanRanges(vlans)),
    ' exit',
    ...[...c.priorities]
      .sort((a, b) => a.instance - b.instance)
      .map((p) => 'spanning-tree mst ' + p.instance + ' priority ' + p.priority),
  ];
}
