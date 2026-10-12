import { bgpMessageSchema, type TcpPacket } from '@shlab/engine';
import { PacketFields } from './PacketFields';

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
              {bgp ? 'Mensagem ' + bgp.type : 'Fragmento de fluxo BGP; o motor reagrupa os segmentos.'}
            </p>
          )}
          {bgp?.type === 'OPEN' && (
            <PacketFields>
              <dt>AS / Router ID</dt>
              <dd>
                {bgp.asn} / {bgp.routerId}
              </dd>
              <dt>Hold time</dt>
              <dd>{bgp.holdMs / 1000} s</dd>
            </PacketFields>
          )}
          {bgp?.type === 'UPDATE' && (
            <PacketFields>
              <dt>Anúncios / retiradas</dt>
              <dd>
                {bgp.announcements.length} / {bgp.withdrawn.length}
              </dd>
            </PacketFields>
          )}
          <pre className="tcp-payload" tabIndex={0} aria-label="Dados da aplicação transportados por TCP">
            {packet.data}
          </pre>
        </details>
      )}
    </>
  );
}
