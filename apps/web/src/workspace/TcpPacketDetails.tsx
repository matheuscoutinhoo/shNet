import { bgpMessageSchema, bgpFrameLength, decodeBgp, type BgpMessage, type TcpPacket } from '@shlab/engine';
import { PacketFields } from './PacketFields';

export function TcpPacketDetails({ packet }: { packet: TcpPacket }) {
  const isBgp = [packet.sourcePort, packet.destinationPort].includes(179);
  const messages: BgpMessage[] = [];
  let partial = false;
  if (isBgp && packet.data) {
    try {
      if (packet.encoding === 'binary') {
        const bytes = Uint8Array.from(packet.data, (c) => c.charCodeAt(0));
        for (let offset = 0; offset < bytes.length;) {
          const remaining = bytes.subarray(offset),
            size = bgpFrameLength(remaining);
          if (!size || remaining.length < size) {
            partial = true;
            break;
          }
          messages.push(decodeBgp(remaining.subarray(0, size)));
          offset += size;
        }
      } else {
        for (const line of packet.data.trim().split('\n'))
          messages.push(bgpMessageSchema.parse(JSON.parse(line)));
      }
    } catch {
      partial = true;
    }
  }
  return (
    <>
      <details open>
        <summary>
          <span>04</span> TCP
        </summary>
        <PacketFields>
          <dt>Source port</dt>
          <dd>{packet.sourcePort}</dd>
          <dt>Destination port</dt>
          <dd>{packet.destinationPort}</dd>
          <dt>Flags</dt>
          <dd>{packet.flags.join(', ')}</dd>
          <dt>Sequence</dt>
          <dd>{packet.sequence}</dd>
          <dt>Acknowledgment</dt>
          <dd>{packet.acknowledgment}</dd>
          <dt>Window</dt>
          <dd>{packet.window} bytes</dd>
        </PacketFields>
      </details>
      {!!packet.data && (
        <details open>
          <summary>
            <span>07</span> {isBgp ? 'BGP' : 'Dados da aplicação'}
          </summary>
          {isBgp && (
            <p className="muted">
              {messages.length ? 'Mensagem ' + messages.map((m) => m.type).join(', ') : ''}
              {(partial || !messages.length) && ' Fragmento de fluxo BGP; o motor reagrupa os segmentos.'}
            </p>
          )}
          {messages.map((bgp, index) =>
            bgp.type === 'OPEN' ? (
              <PacketFields key={index}>
                <dt>AS / Router ID</dt>
                <dd>
                  {bgp.asn} / {bgp.routerId}
                </dd>
                <dt>Hold time</dt>
                <dd>{bgp.holdMs / 1000} s</dd>
              </PacketFields>
            ) : bgp.type === 'UPDATE' ? (
              <PacketFields key={index}>
                <dt>Anúncios / retiradas</dt>
                <dd>
                  {bgp.announcements.length} / {bgp.withdrawn.length}
                </dd>
                <dt>EVPN MAC/IP e IMET / retiradas</dt>
                <dd>
                  {(bgp.evpnAnnouncements?.length ?? 0) + (bgp.evpnImet?.length ?? 0)} /{' '}
                  {(bgp.evpnWithdrawn?.length ?? 0) + (bgp.evpnImetWithdrawn?.length ?? 0)}
                </dd>
              </PacketFields>
            ) : null
          )}
          <pre className="tcp-payload" tabIndex={0} aria-label="Dados da aplicação transportados por TCP">
            {packet.encoding === 'binary'
              ? Array.from(packet.data, (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join(' ')
              : packet.data}
          </pre>
        </details>
      )}
    </>
  );
}
