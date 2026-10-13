"""Independent Scapy validation of generated enterprise/industrial captures."""
import json
import os
import struct
from collections import defaultdict
from pathlib import Path
from scapy.all import Ether, IP, TCP, UDP, VXLAN, rdpcap
from scapy.contrib.modbus import ModbusADURequest, ModbusADUResponse

root = Path('.data/captures')
modbus = rdpcap(str(root / 'modbus.pcap'))
vxlan = rdpcap(str(root / 'vxlan.pcap'))
checked = {'ipv4': 0, 'tcp': 0, 'udp': 0}
for packet in [*modbus, *vxlan]:
    # Rebuild every outer and inner checksum independently of the TS codec.
    for layer in (IP, TCP, UDP):
        index = 1
        while packet.getlayer(layer, index) is not None:
            old = packet.getlayer(layer, index).chksum
            copy = packet.copy()
            del copy.getlayer(layer, index).chksum
            rebuilt = Ether(bytes(copy)).getlayer(layer, index).chksum
            assert rebuilt == old, (layer.__name__, index, old, rebuilt)
            checked[{IP: 'ipv4', TCP: 'tcp', UDP: 'udp'}[layer]] += 1
            index += 1

streams = defaultdict(dict)
for packet in modbus:
    length = packet[IP].len - packet[IP].ihl * 4 - packet[TCP].dataofs * 4 if IP in packet and TCP in packet else 0
    if length > 0:
        key = (packet[IP].src, packet[TCP].sport, packet[IP].dst, packet[TCP].dport)
        streams[key][packet[TCP].seq] = bytes(packet[TCP].payload)[:length]
decoded = []
for key, segments in streams.items():
    data = b''.join(value for _, value in sorted(segments.items()))
    while data:
        assert len(data) >= 9
        transaction, protocol, length = struct.unpack('!HHH', data[:6])
        assert protocol == 0 and 3 <= length <= 254 and len(data) >= 6 + length
        adu, data = data[:6 + length], data[6 + length:]
        parsed = (ModbusADURequest if key[3] == 502 else ModbusADUResponse)(adu)
        assert parsed.transId == transaction and parsed.len == length
        decoded.append({'direction': 'request' if key[3] == 502 else 'response',
                        'transaction': transaction, 'unit': parsed.unitId,
                        'function': adu[7], 'pduHex': adu[7:].hex()})
assert any(x['direction'] == 'request' and x['pduHex'] == '060002fefe' for x in decoded)
assert any(x['direction'] == 'response' and x['pduHex'] == '0304ffff8000' for x in decoded)
assert any(x['direction'] == 'response' and x['pduHex'] == '8302' for x in decoded)
assert any(x['direction'] == 'request' and x['pduHex'] == '100000000204abcd80ff' for x in decoded)
assert any(x['direction'] == 'response' and x['pduHex'] == '1000000002' for x in decoded)
overlays = [p for p in vxlan if VXLAN in p]
assert overlays and all(p[VXLAN].vni == 10010 and int(p[VXLAN].flags) == 8 for p in overlays)
assert all(isinstance(p[VXLAN].payload, Ether) for p in overlays)
summary = {'decoder': 'Scapy', 'checksums': checked, 'modbusPackets': len(modbus),
           'modbusADUs': decoded, 'vxlanPackets': len(vxlan), 'vxlanEnvelopes': len(overlays)}
out = Path(os.environ.get('SHLAB_AUDIT_OUTPUT', 'artifacts/remediation-2026-10-13'))
out.mkdir(parents=True, exist_ok=True)
(out / 'independent-captures.json').write_text(json.dumps(summary, indent=2), encoding='utf-8')
print(json.dumps({'checksums': checked, 'modbusADUs': len(decoded), 'vxlanEnvelopes': len(overlays)}))
