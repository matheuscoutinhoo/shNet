import { freshSimulation } from './labs';
import { sameSubnet } from './protocols/ipv4';
import {
  challengeDefinitionSchema,
  networkTutorial,
  type ChallengeDefinition,
  type LearningEvaluation,
  type LearningPredicate,
  type LearningTaskResult,
} from './learning-model';
import type { Snapshot } from './model';
import type { SimulationEngine } from './core/engine';

export function validateChallenge(input: unknown, snapshot: Snapshot): ChallengeDefinition {
  const definition = challengeDefinitionSchema.parse(input);
  for (const { predicate } of definition.objectives) {
    if ('device' in predicate) {
      const device = snapshot.devices.find((d) => d.id === predicate.device);
      if (!device) throw new Error('Objetivo referencia equipamento inexistente.');
      if ('port' in predicate && !device.interfaces.some((p) => p.id === predicate.port))
        throw new Error('Objetivo referencia interface inexistente.');
      if ('scope' in predicate && predicate.scope && !device.interfaces.some((p) => p.id === predicate.scope))
        throw new Error('Escopo IPv6 inexistente.');
      if ('vrf' in predicate && predicate.vrf && !device.vrfs?.includes(predicate.vrf))
        throw new Error('VRF do objetivo inexistente.');
    }
    if (
      predicate.kind === 'linked' &&
      !snapshot.devices
        .find((d) => d.id === predicate.peer)
        ?.interfaces.some((p) => p.id === predicate.peerPort)
    )
      throw new Error('Extremo do enlace inexistente.');
    if (predicate.kind === 'ping' && predicate.target.startsWith('fe80:') && !predicate.scope)
      throw new Error('Ping link-local requer uma interface de escopo.');
    if (predicate.kind === 'dns' && predicate.type === 'A' && !/^\d+\.\d+\.\d+\.\d+$/.test(predicate.value))
      throw new Error('Valor esperado de registro A deve ser IPv4.');
  }
  return definition;
}

function inspect(
  engine: SimulationEngine,
  predicate: LearningPredicate
): { passed: boolean; evidence: string } {
  const ok = (passed: boolean, evidence: string) => ({ passed, evidence });
  if (predicate.kind === 'devices') {
    const count = engine.state.devices.filter((d) => d.type === predicate.type && d.power).length;
    return ok(count >= predicate.minimum, `${count} equipamento(s) ${predicate.type} ligado(s).`);
  }
  const device = engine.device(predicate.device);
  const port = 'port' in predicate ? device.interfaces.find((p) => p.id === predicate.port) : undefined;
  if (predicate.kind === 'linked')
    return ok(
      !!port?.adminUp &&
        device.power &&
        engine.state.links.some(
          (l) =>
            l.up &&
            ((l.a.device === device.id &&
              l.a.port === port.id &&
              l.b.device === predicate.peer &&
              l.b.port === predicate.peerPort) ||
              (l.b.device === device.id &&
                l.b.port === port.id &&
                l.a.device === predicate.peer &&
                l.a.port === predicate.peerPort))
        ) &&
        !!engine.device(predicate.peer).interfaces.find((p) => p.id === predicate.peerPort)?.adminUp &&
        engine.device(predicate.peer).power,
      'Enlace, energia e interfaces verificados.'
    );
  if (predicate.kind === 'ipv4')
    return ok(
      !!port?.adminUp && device.power && port.ip === predicate.address && port.prefix === predicate.prefix,
      `IPv4 observado: ${port?.ip ?? 'ausente'}/${port?.prefix ?? '-'}.`
    );
  if (predicate.kind === 'vlan')
    return ok(
      !!port?.adminUp &&
        port.mode === predicate.mode &&
        device.vlans.some((v) => v.id === predicate.vlan) &&
        (predicate.mode === 'access'
          ? port.accessVlan === predicate.vlan
          : port.allowedVlans.includes(predicate.vlan)),
      'Modo da porta, VLAN criada e participação verificados.'
    );
  if (predicate.kind === 'dhcp')
    return ok(
      port?.ipv4Mode === 'dhcp' &&
        port.dhcp?.status === 'bound' &&
        !!port.ip &&
        !!engine.state.devices.some((d) =>
          d.dhcpServer?.bindings.some(
            (b) => b.address === port.ip && b.clientMac === port.mac && b.status === 'bound'
          )
        ),
      'Concessão renovada pelo DHCP e binding do servidor correlacionados.'
    );
  if (predicate.kind === 'route')
    return ok(
      (predicate.protocol === 'static'
        ? device.routes
        : predicate.protocol === 'rip'
          ? (device.rip?.table.filter((r) => r.metric < 16) ?? [])
          : predicate.protocol === 'ospf'
            ? (device.ospf?.routes ?? [])
            : (device.bgp?.routes ?? [])
      ).some(
        (r) =>
          r.network === predicate.network &&
          r.prefix === predicate.prefix &&
          (!predicate.nextHop || r.nextHop === predicate.nextHop)
      ),
      'Tabela de rotas após convergência verificada.'
    );
  const advance = (ms: number) => engine.advanceTo(engine.state.clock + ms, 6000);
  if (predicate.kind === 'ping') {
    const family6 = predicate.target.includes(':');
    const id = family6
      ? engine.ping6(device.id, predicate.target, 64, predicate.vrf, predicate.scope)
      : engine.ping(device.id, predicate.target, 64, predicate.vrf);
    advance(31000);
    const probe = (family6 ? engine.state.probes6 : engine.state.probes)?.find((p) => p.id === id);
    // A negative objective requires a protocol rejection. Silence/timeouts cannot impersonate a policy.
    return ok(
      probe?.status === predicate.expect,
      `Novo ICMP${family6 ? 'v6' : 'v4'}: ${probe?.status ?? 'sem resultado'}.`
    );
  }
  if (predicate.kind === 'tcp-echo' || predicate.kind === 'http') {
    const id =
      predicate.kind === 'tcp-echo'
        ? engine.openTcp(
            device.id,
            predicate.target,
            predicate.destinationPort,
            predicate.text,
            true,
            predicate.vrf,
            predicate.scope
          )
        : engine.httpGet(
            device.id,
            predicate.target,
            predicate.destinationPort,
            predicate.path,
            predicate.vrf,
            undefined,
            predicate.scope
          );
    advance(60000);
    const connection = device.tcpConnections?.find((c) => c.id === id);
    const passed =
      predicate.kind === 'tcp-echo'
        ? connection?.received === predicate.text
        : !!connection?.received.startsWith('HTTP/1.1 200') &&
          connection.received.includes(predicate.contains);
    return ok(
      passed,
      `Nova sessão TCP: ${connection?.state ?? 'ausente'}; ${connection?.bytesReceived ?? 0} bytes recebidos.`
    );
  }
  const id = engine.lookupDns(device.id, predicate.name, predicate.type, predicate.server);
  advance(31000);
  const query = device.dnsQueries?.find((q) => q.id === id);
  return ok(
    query?.status === 'success' &&
      query.answers.some((r) => r.type === predicate.type && r.value === predicate.value) &&
      (!predicate.secure || query.security === 'secure'),
    `Nova consulta DNS: ${query?.status ?? 'ausente'}, segurança ${query?.security ?? 'insecure'}.`
  );
}

export function summarizeLearning(tasks: LearningTaskResult[]): LearningEvaluation {
  const passed = tasks.filter((t) => t.passed).length;
  const weight = tasks.reduce((n, t) => n + t.weight, 0);
  return {
    tasks,
    passed,
    total: tasks.length,
    score: weight
      ? Math.floor((100 * tasks.filter((t) => t.passed).reduce((n, t) => n + t.weight, 0)) / weight)
      : 0,
    complete: !!tasks.length && passed === tasks.length,
  };
}
export function evaluateChallenge(input: unknown, snapshot: Snapshot): LearningEvaluation {
  const definition = validateChallenge(input, snapshot);
  const engine = freshSimulation(snapshot);
  const tasks = definition.objectives.map((objective) => {
    try {
      return {
        id: objective.id,
        label: objective.label,
        weight: objective.weight,
        ...inspect(engine, objective.predicate),
      };
    } catch (cause) {
      return {
        id: objective.id,
        label: objective.label,
        weight: objective.weight,
        passed: false,
        evidence: cause instanceof Error ? cause.message : 'Verificação indisponível.',
      };
    }
  });
  return summarizeLearning(tasks);
}

export function evaluateTutorial(snapshot: Snapshot, throughStep: number): LearningEvaluation {
  if (!Number.isInteger(throughStep) || throughStep < 0 || throughStep >= networkTutorial.length)
    throw new Error('Etapa do tutorial inválida.');
  const engine = freshSimulation(snapshot),
    hosts = engine.state.devices.filter((d) => d.type === 'pc'),
    bridge = engine.state.devices.find((d) => d.type === 'switch');
  const [first, second] = hosts;
  const firstPort = first?.interfaces.find((p) => p.media === 'rj45'),
    secondPort = second?.interfaces.find((p) => p.media === 'rj45');
  const results: Array<{ passed: boolean; evidence: string }> = [];
  results.push({
    passed: hosts.filter((d) => d.power).length >= 2 && !!bridge?.power,
    evidence: 'Dois PCs e um switch ligados são necessários.',
  });
  const linked = (id: string, port: string) =>
    engine.state.links.some(
      (l) =>
        l.up &&
        ((l.a.device === id &&
          l.a.port === port &&
          l.b.device === bridge?.id &&
          !!bridge.interfaces.find((p) => p.id === l.b.port)?.adminUp) ||
          (l.b.device === id &&
            l.b.port === port &&
            l.a.device === bridge?.id &&
            !!bridge.interfaces.find((p) => p.id === l.a.port)?.adminUp))
    );
  results.push({
    passed:
      !!firstPort?.adminUp &&
      !!secondPort?.adminUp &&
      linked(first.id, firstPort.id) &&
      linked(second.id, secondPort.id),
    evidence: 'Os dois PCs precisam estar conectados a portas ativas do mesmo switch.',
  });
  results.push({
    passed:
      !!firstPort?.ip &&
      !!secondPort?.ip &&
      firstPort.ip !== secondPort.ip &&
      firstPort.prefix === secondPort.prefix &&
      sameSubnet(firstPort.ip, secondPort.ip, firstPort.prefix!),
    evidence: 'Endereços distintos com prefixo e rede iguais.',
  });
  if (throughStep >= 3) {
    try {
      const result =
        first && secondPort?.ip
          ? inspect(engine, { kind: 'ping', device: first.id, target: secondPort.ip, expect: 'success' })
          : { passed: false, evidence: 'Configure os endereços antes do ping.' };
      results.push({
        ...result,
        passed: result.passed && !!first.arpTable.some((a) => a.ip === secondPort?.ip),
      });
    } catch (cause) {
      results.push({
        passed: false,
        evidence: cause instanceof Error ? cause.message : 'Ping não realizado.',
      });
    }
  }
  if (throughStep >= 4) {
    try {
      results.push(
        first && secondPort?.ip
          ? inspect(engine, {
              kind: 'tcp-echo',
              device: first.id,
              target: secondPort.ip,
              destinationPort: 7,
              text: 'Aprendi TCP no shLab.',
            })
          : { passed: false, evidence: 'Configure os endereços antes do TCP.' }
      );
    } catch (cause) {
      results.push({
        passed: false,
        evidence: cause instanceof Error ? cause.message : 'TCP não realizado.',
      });
    }
  }
  return summarizeLearning(
    results.slice(0, throughStep + 1).map((result, index) => ({
      id: networkTutorial[index].id,
      label: networkTutorial[index].title,
      weight: 1,
      ...result,
    }))
  );
}
