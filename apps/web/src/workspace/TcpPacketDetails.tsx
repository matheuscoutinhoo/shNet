import { bgpMessageSchema, type TcpPacket } from '@shlab/engine';

export function TcpPacketDetails({ packet }: { packet: TcpPacket }) {
  const isBgp = [packet.sourcePort, packet.destinationPort].includes(179);
  let bgp;
  if (isBgp && packet.data.endsWith('\n')) {
    try {
      bgp = bgpMessageSchema.parse(JSON.parse(packet.data.trim()));
    } catch {
      /* A TCP segment can contain part of a message. */
    }
  }
  return (
    <>
      <details open>
        <summary>
          <span>04</span> TCP
        </summary>
        <dl>
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
        </dl>
      </details>
      {!!packet.data && (
        <details open>
          <summary>
            <span>07</span> {isBgp ? 'BGP' : 'Dados da aplicação'}
          </summary>
          {isBgp && (
            <p className="muted">
              {bgp ? 'Mensagem ' + bgp.type : 'Fragmento de fluxo BGP; o motor reagrupa os segmentos.'}
            </p>
          )}
          {bgp?.type === 'OPEN' && (
            <dl>
              <dt>AS / Router ID</dt>
              <dd>
                {bgp.asn} / {bgp.routerId}
              </dd>
              <dt>Hold time</dt>
              <dd>{bgp.holdMs / 1000} s</dd>
            </dl>
          )}
          {bgp?.type === 'UPDATE' && (
            <dl>
              <dt>Anúncios / retiradas</dt>
              <dd>
                {bgp.announcements.length} / {bgp.withdrawn.length}
              </dd>
            </dl>
          )}
          <pre className="tcp-payload">{packet.data}</pre>
        </details>
      )}
    </>
  );
}
