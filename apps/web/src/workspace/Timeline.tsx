import { useState } from 'react';
import { Activity, ChevronRight, Info, List, Send, StickyNote, X } from 'lucide-react';
import { bridgeLabel, type NetworkEvent } from '@shlab/engine';
import type { LabController } from './useLab';
import { Modal } from '../components/Modal';
import { TcpPacketDetails } from './TcpPacketDetails';
export function Timeline({ lab, onSelect }: { lab: LabController; onSelect: (id: string) => void }) {
  const [tab, setTab] = useState('events'),
    [filter, setFilter] = useState('all'),
    [event, setEvent] = useState<NetworkEvent | null>(null);
  const events = lab.engine.state.events.filter(
    (e) =>
      filter === 'all' ||
      (filter === 'aaa'
        ? e.type.startsWith('AAA') ||
          e.type.startsWith('DOT1X') ||
          !!e.frame?.eapol ||
          (e.frame?.packet?.protocol === 'UDP' && e.frame.packet.payload.protocol === 'RADIUS') ||
          (e.frame?.packet?.protocol === 'TCP' &&
            [e.frame.packet.sourcePort, e.frame.packet.destinationPort].includes(49))
        : filter === 'vxlan'
          ? e.type.startsWith('VXLAN') ||
            e.type.startsWith('EVPN') ||
            (e.frame?.packet?.protocol === 'UDP' && e.frame.packet.payload.protocol === 'VXLAN')
          : filter === 'forwarding'
            ? e.type.startsWith('QOS') || e.type.startsWith('MPLS') || !!e.frame?.mpls
            : filter === 'tunnel'
              ? e.type.startsWith('TUNNEL') ||
                e.type.startsWith('SDWAN') ||
                (e.frame?.packet?.protocol === 'UDP' &&
                  ['TUNNEL', 'SDWAN'].includes(e.frame.packet.payload.protocol))
              : filter === 'wireless'
                ? e.type.startsWith('WIFI') ||
                  !!e.frame?.wifi ||
                  (e.link && lab.engine.state.links.find((l) => l.id === e.link)?.cable === 'wireless')
                : filter === 'ipv6'
                  ? e.type.startsWith('IPV6') || e.type.startsWith('NDP') || !!e.frame?.ipv6
                  : filter === 'lacp'
                    ? e.type.startsWith('LACP') || !!e.frame?.lacp
                    : filter === 'bgp'
                      ? e.type.startsWith('BGP') ||
                        (e.type.startsWith('ROUTE_') && e.reason.startsWith('BGP')) ||
                        (e.frame?.packet?.protocol === 'TCP' &&
                          [e.frame.packet.sourcePort, e.frame.packet.destinationPort].includes(179))
                      : filter === 'vrrp'
                        ? e.type.startsWith('VRRP') || e.frame?.packet?.protocol === 'VRRP'
                        : filter === 'management'
                          ? e.type.startsWith('REMOTE') ||
                            e.type.startsWith('AUTOMATION') ||
                            e.type.startsWith('TELEMETRY') ||
                            e.type.startsWith('NTP') ||
                            e.type.startsWith('SNMP') ||
                            e.type.startsWith('SYSLOG') ||
                            (e.frame?.packet?.protocol === 'UDP' &&
                              ['SNMP', 'SYSLOG', 'TELEMETRY', 'NTP'].includes(
                                e.frame.packet.payload.protocol
                              ))
                          : filter === 'arp'
                            ? e.type.startsWith('ARP')
                            : filter === 'drops'
                              ? e.type === 'PACKET_DROPPED' ||
                                e.type === 'PING_TIMEOUT' ||
                                e.type === 'DNS_FAILED' ||
                                e.type === 'DNS_TIMEOUT' ||
                                e.type === 'TCP_TIMEOUT' ||
                                e.type === 'TCP_RESET'
                              : filter === 'icmp'
                                ? e.frame?.packet?.protocol === 'ICMP' || e.type.startsWith('PING')
                                : filter === 'dhcp'
                                  ? e.type.startsWith('DHCP') ||
                                    (e.frame?.packet?.protocol === 'UDP' &&
                                      e.frame.packet.payload.protocol === 'DHCP')
                                  : filter === 'dns'
                                    ? e.type.startsWith('DNS') ||
                                      (e.frame?.packet?.protocol === 'UDP' &&
                                        e.frame.packet.payload.protocol === 'DNS')
                                    : filter === 'tcp'
                                      ? e.type.startsWith('TCP') ||
                                        e.type === 'APPLICATION_DATA' ||
                                        e.frame?.packet?.protocol === 'TCP'
                                      : filter === 'ospf'
                                        ? e.type.startsWith('OSPF') ||
                                          e.type.startsWith('ROUTE_') ||
                                          e.frame?.packet?.protocol === 'OSPF'
                                        : filter === 'rip'
                                          ? e.type.startsWith('RIP') ||
                                            (e.type.startsWith('ROUTE_') && e.reason.startsWith('RIP')) ||
                                            (e.frame?.packet?.protocol === 'UDP' &&
                                              e.frame.packet.payload.protocol === 'RIP')
                                          : filter === 'policy'
                                            ? e.type.startsWith('ACL') ||
                                              e.type.startsWith('NAT') ||
                                              e.type.startsWith('FIREWALL')
                                            : filter === 'stp'
                                              ? e.type.startsWith('STP') ||
                                                e.type.startsWith('BPDU') ||
                                                !!e.frame?.bpdu
                                              : e.type.startsWith('FRAME') || e.type === 'MAC_LEARNED')
  );
  return (
    <section className="timeline">
      <div className="timeline-header">
        <div className="timeline-tabs">
          <button className={tab === 'events' ? 'active' : ''} onClick={() => setTab('events')}>
            <List size={15} /> Eventos <span>{lab.engine.state.events.length}</span>
          </button>
          <button className={tab === 'traffic' ? 'active' : ''} onClick={() => setTab('traffic')}>
            <Activity size={15} /> Tráfego <span>{lab.engine.state.probes.length}</span>
          </button>
          <button className={tab === 'notes' ? 'active' : ''} onClick={() => setTab('notes')}>
            <StickyNote size={15} /> Notas do laboratório
          </button>
        </div>
        <span className="timeline-clock">
          TEMPO VIRTUAL <strong>{lab.engine.state.clock.toFixed(3)} ms</strong>
        </span>
      </div>
      {tab === 'events' && (
        <>
          <div className="event-filters">
            {[
              ['all', 'Todos'],
              ['arp', 'ARP'],
              ['icmp', 'ICMP'],
              ['dhcp', 'DHCP'],
              ['dns', 'DNS'],
              ['tcp', 'TCP'],
              ['ospf', 'OSPF'],
              ['vrrp', 'VRRP'],
              ['lacp', 'LACP'],
              ['ipv6', 'IPv6 / NDP'],
              ['wireless', 'Wi-Fi'],
              ['tunnel', 'VPN / SD-WAN'],
              ['forwarding', 'QoS / MPLS'],
              ['vxlan', 'VXLAN / EVPN'],
              ['aaa', '802.1X / AAA'],
              ['bgp', 'BGP'],
              ['rip', 'RIP'],
              ['management', 'Gerenciamento'],
              ['stp', 'STP'],
              ['policy', 'ACL / NAT'],
              ['ethernet', 'Ethernet'],
              ['drops', 'Descartes'],
            ].map(([id, label]) => (
              <button key={id} className={filter === id ? 'active' : ''} onClick={() => setFilter(id)}>
                {label}
              </button>
            ))}
            <span>Clique em um evento para entender a decisão.</span>
          </div>
          <div className="event-table-wrap">
            <table className="event-table">
              <thead>
                <tr>
                  <th>Tempo (ms)</th>
                  <th>Equipamento</th>
                  <th>Evento</th>
                  <th>O que aconteceu?</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {events
                  .slice(-150)
                  .reverse()
                  .map((e) => (
                    <tr
                      key={e.id}
                      onClick={() => setEvent(e)}
                      tabIndex={0}
                      onKeyDown={(k) => {
                        if (k.key === 'Enter') setEvent(e);
                      }}
                    >
                      <td>{e.time.toFixed(3)}</td>
                      <td>{lab.engine.state.devices.find((d) => d.id === e.device)?.hostname ?? e.device}</td>
                      <td>
                        <span
                          className={
                            'event-badge ' +
                            (e.type.includes('DROPPED') || e.type.includes('TIMEOUT')
                              ? 'error'
                              : e.type.includes('ARP')
                                ? 'arp'
                                : e.type.includes('SUCCESS')
                                  ? 'success'
                                  : '')
                          }
                        >
                          {e.type}
                        </span>
                      </td>
                      <td>{e.reason}</td>
                      <td>
                        <ChevronRight size={14} />
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
            {!events.length && (
              <div className="timeline-empty">
                <Send size={21} />
                <div>
                  <strong>O próximo pacote conta uma história.</strong>
                  <span>Envie um ping para acompanhar as decisões da sua rede.</span>
                </div>
              </div>
            )}
          </div>
        </>
      )}
      {tab === 'traffic' && (
        <div className="traffic-table">
          <table>
            <thead>
              <tr>
                <th>Origem</th>
                <th>Destino</th>
                <th>TTL inicial</th>
                <th>Resultado</th>
                <th>Respondente</th>
                <th>RTT</th>
              </tr>
            </thead>
            <tbody>
              {lab.engine.state.probes
                .slice()
                .reverse()
                .map((p) => (
                  <tr key={p.id}>
                    <td>
                      <button className="text-button" onClick={() => onSelect(p.device)}>
                        {lab.engine.device(p.device).hostname}
                      </button>
                    </td>
                    <td>{p.target}</td>
                    <td>{p.ttl}</td>
                    <td className={p.status === 'success' ? 'good' : p.status === 'pending' ? '' : 'bad'}>
                      {p.status === 'success'
                        ? '✓ Recebido'
                        : p.status === 'pending'
                          ? 'Aguardando…'
                          : p.status}
                    </td>
                    <td>{p.responder ?? '—'}</td>
                    <td>{p.rtt !== undefined ? p.rtt.toFixed(3) + ' ms' : '—'}</td>
                  </tr>
                ))}
            </tbody>
          </table>
          {!lab.engine.state.probes.length && <p className="table-empty">Nenhum probe enviado.</p>}
        </div>
      )}
      {tab === 'notes' && (
        <textarea
          className="lab-notes"
          aria-label="Notas do laboratório"
          placeholder="Documente hipóteses, endereços e descobertas…"
          maxLength={10000}
          value={lab.engine.state.notes}
          onChange={(e) =>
            lab.change((sim) => {
              sim.state.notes = e.target.value;
            }, false)
          }
        />
      )}
      {event && (
        <Modal title="Por que isso aconteceu?" onClose={() => setEvent(null)} wide>
          <div className="packet-title">
            <span className="event-badge">{event.type}</span>
            <span>{event.time.toFixed(3)} ms</span>
          </div>
          <div className="learning-card">
            <span>
              <Info size={17} /> Decisão do motor
            </span>
            <p>{event.reason}</p>
          </div>
          <dl className="key-values">
            <div>
              <dt>Equipamento</dt>
              <dd>{lab.engine.state.devices.find((d) => d.id === event.device)?.hostname ?? event.device}</dd>
            </div>
            <div>
              <dt>Interface</dt>
              <dd>
                {lab.engine.state.devices
                  .find((d) => d.id === event.device)
                  ?.interfaces.find((i) => i.id === event.port)?.name ?? '—'}
              </dd>
            </div>
          </dl>
          {event.frame?.fragment && (
            <section className="packet-layer">
              <h3>Fragmento IPv4</h3>
              <dl>
                <dt>Origem → destino</dt>
                <dd>
                  {event.frame.fragment.src} → {event.frame.fragment.dst}
                </dd>
                <dt>Protocolo / TTL</dt>
                <dd>
                  {event.frame.fragment.protocol} / {event.frame.fragment.ttl}
                </dd>
                <dt>Identification</dt>
                <dd>{event.frame.fragment.identification}</dd>
                <dt>Fragment Offset</dt>
                <dd>{event.frame.fragment.offset / 8} (× 8 bytes)</dd>
                <dt>More Fragments</dt>
                <dd>{String(event.frame.fragment.more)}</dd>
                <dt>Tamanho</dt>
                <dd>
                  {event.frame.fragment.bytes} bytes; {event.frame.fragment.data.length} de payload
                </dd>
              </dl>
              <p className="muted">
                A aplicação recebe os dados após reassembly completo. Um fragmento perdido ou sobreposto
                invalida a entrega.
              </p>
            </section>
          )}
          {event.frame?.ipv6 && (
            <section className="packet-layer">
              <h3>IPv6 — ICMPv6 / NDP</h3>
              <dl>
                <dt>Origem</dt>
                <dd>{event.frame.ipv6.src}</dd>
                <dt>Destino</dt>
                <dd>{event.frame.ipv6.dst}</dd>
                <dt>Hop Limit</dt>
                <dd>{event.frame.ipv6.hopLimit}</dd>
                <dt>Tipo ICMPv6</dt>
                <dd>{event.frame.ipv6.kind}</dd>
                <dt>Tamanho</dt>
                <dd>{event.frame.ipv6.bytes} bytes</dd>
                {event.frame.ipv6.target && (
                  <>
                    <dt>Alvo NDP</dt>
                    <dd>{event.frame.ipv6.target}</dd>
                  </>
                )}
                {event.frame.ipv6.mtu && (
                  <>
                    <dt>MTU anunciada</dt>
                    <dd>{event.frame.ipv6.mtu}</dd>
                  </>
                )}
              </dl>
              {event.frame.ipv6.prefixes?.map((p) => (
                <p key={p.network}>
                  {p.network}/{p.prefix} · L={String(p.onLink)} A={String(p.autonomous)} · válida{' '}
                  {p.validMs / 1000} s / preferida {p.preferredMs / 1000} s
                </p>
              ))}
              {event.frame.ipv6.quote && (
                <p>
                  Pacote citado: {event.frame.ipv6.quote.src} → {event.frame.ipv6.quote.dst}
                </p>
              )}
            </section>
          )}
          {event.frame?.eapol && (
            <section className="packet-layer">
              <h3>802.1X — EAPOL</h3>
              <pre>{JSON.stringify(event.frame.eapol, null, 2)}</pre>
              <p className="muted">
                Controle link-local na porta não controlada; dados dependem da resposta RADIUS.
              </p>
            </section>
          )}
          {event.frame?.mpls && (
            <section className="packet-layer">
              <h3>MPLS — labels</h3>
              <dl>
                <dt>Pilha externa → interna</dt>
                <dd>
                  {event.frame.mpls.labels
                    .map((l) => l.value + ' / TTL ' + l.ttl + ' / TC ' + l.tc)
                    .join(' → ')}
                </dd>
                <dt>Tamanho</dt>
                <dd>{event.frame.mpls.bytes} bytes</dd>
                <dt>Pacote interno</dt>
                <dd className="ciphertext">{event.frame.mpls.packet}</dd>
              </dl>
            </section>
          )}
          {event.frame?.secure && (
            <section className="packet-layer">
              <h3>802.11 — payload protegido</h3>
              <dl>
                <dt>Cipher</dt>
                <dd>{event.frame.secure.cipher}</dd>
                <dt>Sequência</dt>
                <dd>{event.frame.secure.sequence}</dd>
                <dt>Integridade</dt>
                <dd>{event.frame.secure.tag}</dd>
                <dt>Payload cifrado</dt>
                <dd className="ciphertext">
                  {event.frame.secure.body.slice(0, 256)}
                  {event.frame.secure.body.length > 256 ? '…' : ''}
                </dd>
              </dl>
              <p className="muted">
                Cifra didática. O payload é aberto na interface associada; não implementa AES/CCMP/GCMP real.
              </p>
            </section>
          )}
          {event.frame?.wifi && (
            <section className="packet-layer">
              <h3>802.11 — associação e segurança</h3>
              <dl>
                <dt>Mensagem</dt>
                <dd>{event.frame.wifi.kind}</dd>
                <dt>SSID</dt>
                <dd>{event.frame.wifi.ssid}</dd>
                <dt>Segurança</dt>
                <dd>{event.frame.wifi.security}</dd>
                <dt>Negociação</dt>
                <dd>{event.frame.wifi.token ?? 'Beacon'}</dd>
                <dt>Nonce</dt>
                <dd>{event.frame.wifi.nonce ?? '—'}</dd>
              </dl>
              <p className="muted">
                Mensagens e prova de credencial do modelo didático. A chave não é enviada nesta PDU; não há
                cifragem real.
              </p>
            </section>
          )}
          {event.frame?.lacp && (
            <section className="packet-layer">
              <h3>LACP — controle de agregação</h3>
              <dl>
                <dt>Actor system / key / port</dt>
                <dd>
                  {event.frame.lacp.actor.system} / {event.frame.lacp.actor.key} /{' '}
                  {event.frame.lacp.actor.port}
                </dd>
                <dt>Modo</dt>
                <dd>{event.frame.lacp.active ? 'active' : 'passive'}</dd>
                <dt>Partner</dt>
                <dd>
                  {event.frame.lacp.partner ? JSON.stringify(event.frame.lacp.partner) : 'Não reconhecido'}
                </dd>
              </dl>
            </section>
          )}
          {event.frame && (
            <div className="packet-layers">
              <section className="osi-stack" aria-label="Modelo OSI">
                {[
                  [
                    '7',
                    'Aplicação',
                    event.frame.packet?.protocol === 'UDP'
                      ? event.frame.packet.payload.protocol
                      : event.frame.packet?.protocol === 'TCP'
                        ? 'Stream de aplicação'
                        : 'Não aplicável',
                  ],
                  ['6', 'Apresentação', 'Não modelada'],
                  ['5', 'Sessão', 'Não modelada'],
                  [
                    '4',
                    'Transporte',
                    event.frame.packet && ['UDP', 'TCP'].includes(event.frame.packet.protocol)
                      ? event.frame.packet.protocol
                      : 'Não aplicável',
                  ],
                  [
                    '3',
                    'Rede',
                    event.frame.packet
                      ? 'IPv4 / ' + event.frame.packet.protocol
                      : event.frame.arp
                        ? 'Resolução IPv4'
                        : 'Controle L2',
                  ],
                  [
                    '2',
                    'Enlace',
                    event.frame.bpdu ? '802.3 / LLC' : event.frame.vlan ? 'Ethernet / 802.1Q' : 'Ethernet',
                  ],
                  [
                    '1',
                    'Física',
                    lab.engine.state.links.find((link) => link.id === event.link)?.cable ?? 'Interface local',
                  ],
                ].map(([number, name, value]) => (
                  <div key={number}>
                    <strong>{number}</strong>
                    <span>{name}</span>
                    <small>{value}</small>
                  </div>
                ))}
              </section>
              <details open>
                <summary>
                  <span>02</span> {event.frame.bpdu ? 'IEEE 802.3 / LLC' : 'Ethernet II'}
                </summary>
                <dl>
                  <dt>Source MAC</dt>
                  <dd>{event.frame.src}</dd>
                  <dt>Destination MAC</dt>
                  <dd>{event.frame.dst}</dd>
                  <dt>{event.frame.bpdu ? 'Encapsulation' : 'EtherType'}</dt>
                  <dd>
                    {event.frame.etherType === 'EAPOL'
                      ? '0x888E (EAPOL)'
                      : event.frame.etherType === 'MPLS'
                        ? '0x8847'
                        : event.frame.etherType === 'STP'
                          ? '802.3 LLC / BPDU (0x42)'
                          : event.frame.etherType === 'ARP'
                            ? '0x0806 (ARP)'
                            : event.frame.etherType === 'IPv6'
                              ? '0x86DD (IPv6)'
                              : event.frame.etherType === 'LACP'
                                ? '0x8809 (LACP)'
                                : event.frame.etherType === '802.11' ||
                                    event.frame.etherType === '802.11-secure'
                                  ? 'Controle 802.11 (modelo)'
                                  : '0x0800 (IPv4)'}
                  </dd>
                  <dt>802.1Q</dt>
                  <dd>{event.frame.vlan ?? 'Sem tag (native/access)'}</dd>
                </dl>
              </details>
              {event.frame.bpdu && (
                <details open>
                  <summary>
                    <span>02</span> {event.frame.bpdu.mode.toUpperCase()} BPDU
                  </summary>
                  <dl>
                    <dt>Root ID</dt>
                    <dd>{bridgeLabel(event.frame.bpdu.root)}</dd>
                    {event.frame.bpdu.domain && (
                      <>
                        <dt>Domínio / instância</dt>
                        <dd>
                          {event.frame.bpdu.domain.toUpperCase()} / {event.frame.bpdu.instance ?? 0}
                        </dd>
                      </>
                    )}
                    <dt>Root path cost</dt>
                    <dd>{event.frame.bpdu.cost}</dd>
                    <dt>Bridge ID</dt>
                    <dd>{bridgeLabel(event.frame.bpdu.bridge)}</dd>
                    <dt>Port ID</dt>
                    <dd>{event.frame.bpdu.portId}</dd>
                    <dt>Message age</dt>
                    <dd>{event.frame.bpdu.age.toFixed(3)} ms</dd>
                    <dt>Proposal / Agreement</dt>
                    <dd>
                      {Number(event.frame.bpdu.proposal)} / {Number(event.frame.bpdu.agreement)}
                    </dd>
                    <dt>Topology change</dt>
                    <dd>{event.frame.bpdu.changeId ? 'TC' : '-'}</dd>
                  </dl>
                </details>
              )}
              {event.frame.arp && (
                <details open>
                  <summary>
                    <span>02</span> Address Resolution Protocol
                  </summary>
                  <dl>
                    <dt>Operation</dt>
                    <dd>{event.frame.arp.kind}</dd>
                    <dt>Sender IPv4</dt>
                    <dd>{event.frame.arp.senderIp}</dd>
                    <dt>Target IPv4</dt>
                    <dd>{event.frame.arp.targetIp}</dd>
                  </dl>
                </details>
              )}
              {event.frame.packet && (
                <>
                  <details open>
                    <summary>
                      <span>03</span> IPv4
                    </summary>
                    <dl>
                      <dt>Source</dt>
                      <dd>{event.frame.packet.src}</dd>
                      <dt>Destination</dt>
                      <dd>{event.frame.packet.dst}</dd>
                      <dt>TTL</dt>
                      <dd>{event.frame.packet.ttl}</dd>
                      <dt>Protocol</dt>
                      <dd>
                        {
                          {
                            ICMP: '1 (ICMP)',
                            UDP: '17 (UDP)',
                            TCP: '6 (TCP)',
                            OSPF: '89 (OSPF)',
                            VRRP: '112 (VRRP)',
                          }[event.frame.packet.protocol]
                        }
                      </dd>
                      <dt>Length</dt>
                      <dd>{event.frame.packet.bytes} bytes</dd>
                    </dl>
                  </details>
                  {event.frame.packet.protocol === 'ICMP' ? (
                    <details open>
                      <summary>
                        <span>03</span> ICMP
                      </summary>
                      <dl>
                        <dt>Type / Code</dt>
                        <dd>
                          {
                            {
                              'echo-request': '8 / 0',
                              'echo-reply': '0 / 0',
                              'time-exceeded': '11 / 0',
                              unreachable: '3 / ' + (event.frame.packet.error?.code ?? 0),
                            }[event.frame.packet.kind]
                          }
                        </dd>
                        <dt>Message</dt>
                        <dd>{event.frame.packet.kind}</dd>
                        <dt>Identifier</dt>
                        <dd>{event.frame.packet.probeId}</dd>
                        {event.frame.packet.error && (
                          <>
                            <dt>Cabeçalho citado</dt>
                            <dd>
                              {event.frame.packet.error.quote.protocol} · {event.frame.packet.error.quote.src}{' '}
                              → {event.frame.packet.error.quote.dst}
                            </dd>
                            <dt>
                              {event.frame.packet.error.quote.protocol === 'ICMP'
                                ? 'Identificador citado'
                                : 'Portas citadas'}
                            </dt>
                            <dd>
                              {event.frame.packet.error.quote.protocol === 'ICMP'
                                ? event.frame.packet.error.quote.probeId
                                : event.frame.packet.error.quote.sourcePort +
                                  ' → ' +
                                  event.frame.packet.error.quote.destinationPort}
                            </dd>
                            {event.frame.packet.error.quote.protocol === 'TCP' && (
                              <>
                                <dt>Sequência citada</dt>
                                <dd>{event.frame.packet.error.quote.sequence}</dd>
                              </>
                            )}
                          </>
                        )}
                      </dl>
                    </details>
                  ) : event.frame.packet.protocol === 'VRRP' ? (
                    <details open>
                      <summary>
                        <span>03</span> VRRPv3
                      </summary>
                      <dl>
                        <dt>VRID / VIP</dt>
                        <dd>
                          {event.frame.packet.vrid} / {event.frame.packet.vip}
                        </dd>
                        <dt>Prioridade</dt>
                        <dd>{event.frame.packet.priority}</dd>
                        <dt>Intervalo anunciado</dt>
                        <dd>{event.frame.packet.advertMs} ms</dd>
                      </dl>
                    </details>
                  ) : event.frame.packet.protocol === 'OSPF' ? (
                    <details open>
                      <summary>
                        <span>03</span> OSPF
                      </summary>
                      <dl>
                        <dt>Router ID</dt>
                        <dd>{event.frame.packet.routerId}</dd>
                        <dt>Área</dt>
                        <dd>{event.frame.packet.area}</dd>
                        <dt>Mensagem</dt>
                        <dd>{event.frame.packet.message.type}</dd>
                      </dl>
                      <pre>{JSON.stringify(event.frame.packet.message, null, 2)}</pre>
                    </details>
                  ) : event.frame.packet.protocol === 'TCP' ? (
                    <TcpPacketDetails packet={event.frame.packet} />
                  ) : (
                    <>
                      <details open>
                        <summary>
                          <span>04</span> UDP
                        </summary>
                        <dl>
                          <dt>Source port</dt>
                          <dd>{event.frame.packet.sourcePort}</dd>
                          <dt>Destination port</dt>
                          <dd>{event.frame.packet.destinationPort}</dd>
                        </dl>
                      </details>
                      {event.frame.packet.payload.protocol === 'VXLAN' && (
                        <section className="packet-layer">
                          <h3>VXLAN — UDP/4789</h3>
                          <dl>
                            <dt>VNI</dt>
                            <dd>{event.frame.packet.payload.message.vni}</dd>
                            <dt>Flag I</dt>
                            <dd>1</dd>
                            <dt>Payload Ethernet interno</dt>
                            <dd className="ciphertext">{event.frame.packet.payload.message.frame}</dd>
                          </dl>
                        </section>
                      )}
                      {event.frame.packet.payload.protocol === 'TUNNEL' && (
                        <section className="pdu-layer">
                          <h4>Túnel sobre UDP/4500</h4>
                          <pre>
                            {JSON.stringify(
                              {
                                ...event.frame.packet.payload.message,
                                ...(event.frame.packet.payload.message.kind === 'data'
                                  ? { body: event.frame.packet.payload.message.body.slice(0, 128) + '…' }
                                  : {}),
                              },
                              null,
                              2
                            )}
                          </pre>
                        </section>
                      )}
                      {event.frame.packet.payload.protocol === 'SDWAN' && (
                        <section className="pdu-layer">
                          <h4>Controle SD-WAN</h4>
                          <pre>{JSON.stringify(event.frame.packet.payload.message, null, 2)}</pre>
                        </section>
                      )}
                      {event.frame.packet.payload.protocol === 'DNS' && (
                        <details open>
                          <summary>
                            <span>07</span> DNS
                          </summary>
                          <dl>
                            <dt>Message</dt>
                            <dd>{event.frame.packet.payload.message.type}</dd>
                            <dt>Transaction ID</dt>
                            <dd>{event.frame.packet.payload.message.transactionId}</dd>
                            <dt>Question</dt>
                            <dd>
                              {event.frame.packet.payload.message.question.name}{' '}
                              {event.frame.packet.payload.message.question.type}
                            </dd>
                            <dt>Recursion desired</dt>
                            <dd>{String(event.frame.packet.payload.message.recursionDesired)}</dd>
                            {event.frame.packet.payload.message.type === 'response' && (
                              <>
                                <dt>Response code</dt>
                                <dd>{event.frame.packet.payload.message.code}</dd>
                                <dt>AA / RA / TC</dt>
                                <dd>
                                  {Number(event.frame.packet.payload.message.authoritative)} /{' '}
                                  {Number(event.frame.packet.payload.message.recursionAvailable)} /{' '}
                                  {Number(event.frame.packet.payload.message.truncated)}
                                </dd>
                                {event.frame.packet.payload.message.answers.map((answer, index) => (
                                  <div className="dns-answer" key={index}>
                                    <dt>
                                      {answer.name} {answer.type}
                                    </dt>
                                    <dd>
                                      {answer.value} · TTL {answer.ttl} s
                                    </dd>
                                  </div>
                                ))}
                              </>
                            )}
                          </dl>
                        </details>
                      )}
                      {event.frame.packet.payload.protocol === 'RIP' && (
                        <details open>
                          <summary>
                            <span>07</span> RIPv2
                          </summary>
                          <pre>{JSON.stringify(event.frame.packet.payload.message, null, 2)}</pre>
                        </details>
                      )}
                      {(event.frame.packet.payload.protocol === 'SNMP' ||
                        event.frame.packet.payload.protocol === 'SYSLOG') && (
                        <details open>
                          <summary>
                            <span>07</span> {event.frame.packet.payload.protocol}
                          </summary>
                          <pre>{JSON.stringify(event.frame.packet.payload.message, null, 2)}</pre>
                        </details>
                      )}
                      {event.frame.packet.payload.protocol === 'DHCP' && (
                        <details open>
                          <summary>
                            <span>07</span> DHCP
                          </summary>
                          <dl>
                            <dt>Message</dt>
                            <dd>{event.frame.packet.payload.message.type.toUpperCase()}</dd>
                            <dt>Transaction ID</dt>
                            <dd>{event.frame.packet.payload.message.transactionId}</dd>
                            <dt>Client MAC</dt>
                            <dd>{event.frame.packet.payload.message.clientMac}</dd>
                            <dt>Client IPv4</dt>
                            <dd>{event.frame.packet.payload.message.clientIp}</dd>
                            <dt>giaddr (relay)</dt>
                            <dd>{event.frame.packet.payload.message.giaddr ?? '0.0.0.0'}</dd>
                            <dt>Relay hops</dt>
                            <dd>{event.frame.packet.payload.message.hops ?? 0}</dd>
                            {'server' in event.frame.packet.payload.message && (
                              <>
                                <dt>Server identifier</dt>
                                <dd>{event.frame.packet.payload.message.server ?? '-'}</dd>
                              </>
                            )}
                            {'requestedIp' in event.frame.packet.payload.message && (
                              <>
                                <dt>Requested IPv4</dt>
                                <dd>{event.frame.packet.payload.message.requestedIp}</dd>
                              </>
                            )}
                            {'address' in event.frame.packet.payload.message && (
                              <>
                                <dt>Offered IPv4</dt>
                                <dd>
                                  {event.frame.packet.payload.message.address}/
                                  {event.frame.packet.payload.message.prefix}
                                </dd>
                                <dt>Router option</dt>
                                <dd>{event.frame.packet.payload.message.gateway ?? '-'}</dd>
                                <dt>DNS option</dt>
                                <dd>{event.frame.packet.payload.message.dns.join(', ') || '-'}</dd>
                                <dt>Lease</dt>
                                <dd>{event.frame.packet.payload.message.leaseMs / 1000} s</dd>
                              </>
                            )}
                          </dl>
                        </details>
                      )}
                    </>
                  )}
                </>
              )}
            </div>
          )}
          <div className="button-row">
            <button
              className="button"
              onClick={() => {
                onSelect(event.device);
                setEvent(null);
              }}
            >
              Inspecionar equipamento <ChevronRight size={16} />
            </button>
            <button className="button" onClick={() => setEvent(null)}>
              <X size={15} /> Fechar
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
