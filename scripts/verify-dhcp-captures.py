"""Independent DHCPv4/BOOTP, option and checksum verification with Scapy/TShark."""
import ipaddress
import json
import shutil
import subprocess
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from scapy.all import Ether, IP, UDP, BOOTP, DHCP, rdpcap

root = Path(sys.argv[1] if len(sys.argv) > 1 else 'artifacts/dhcp-captures-2026-10-15')
manifest = json.loads((root / 'captures.json').read_text(encoding='utf-8'))
types = {'discover': 1, 'offer': 2, 'request': 3, 'decline': 4, 'ack': 5, 'nak': 6, 'release': 7}
tshark = shutil.which('tshark') or (r'C:\Program Files\Wireshark\tshark.exe' if sys.platform == 'win32' else None)
assert tshark, 'TShark required; no independent-decoder skip.'
checked = Counter()
results = []
for scenario in manifest['scenarios']:
    path = root / (scenario['name'] + '.pcap')
    packets = rdpcap(str(path))
    assert len(packets) == scenario['packets'] == len(scenario['frames'])
    assert scenario['dropped'] == 0 and not scenario['excluded']
    messages = Counter()
    relay_request = relay_reply = renewed = rebound = backup_ack = False
    for packet, expected in zip(packets, scenario['frames']):
        assert len(bytes(packet)) == expected['bytes']
        assert packet[Ether].src == expected['sourceMac'].lower()
        assert packet[Ether].dst == expected['destinationMac'].lower()
        for layer, label in [(IP, 'ipv4Checksums'), (UDP, 'udpChecksums')]:
            if layer in packet:
                original = packet[layer].chksum
                copy = packet.copy()
                del copy[layer].chksum
                assert Ether(bytes(copy))[layer].chksum == original
                checked[label] += 1
        m = expected.get('dhcp')
        if m is None:
            continue
        assert BOOTP in packet and DHCP in packet
        boot = packet[BOOTP]
        options = {o[0]: o[1:] for o in packet[DHCP].options if isinstance(o, tuple)}
        kind = m['type']
        messages[kind] += 1
        assert options['message-type'] == (types[kind],)
        assert boot.op == (2 if kind in ('offer', 'ack', 'nak') else 1)
        assert boot.htype == 1 and boot.hlen == 6
        assert boot.xid == int(m['transactionId'].removeprefix('dhcp-'))
        assert boot.chaddr[:6].hex() == m['clientMac'].replace(':', '').lower()
        assert boot.chaddr[6:] == bytes(10)
        assert boot.ciaddr == ('0.0.0.0' if kind == 'nak' else m['clientIp'])
        assert boot.yiaddr == m.get('address', '0.0.0.0')
        assert boot.siaddr == '0.0.0.0'
        assert boot.giaddr == m.get('giaddr', '0.0.0.0')
        assert boot.hops == m.get('hops', 0)
        assert bool(int(boot.flags) & 0x8000) == (m['clientIp'] == '0.0.0.0' or kind == 'nak')
        assert packet[IP].src == expected['source'] and packet[IP].dst == expected['destination']
        assert packet[IP].len == expected['ipBytes']
        assert packet[UDP].sport == expected['sourcePort'] and packet[UDP].dport == expected['destinationPort']
        assert packet[UDP].len + 20 == expected['ipBytes']
        if 'server' in m:
            assert options['server_id'] == (m['server'],)
        else:
            assert 'server_id' not in options
        if 'requestedIp' in m and (kind == 'decline' or m['clientIp'] == '0.0.0.0'):
            assert options['requested_addr'] == (m['requestedIp'],)
        else:
            assert 'requested_addr' not in options
        if 'leaseMs' in m:
            assert options['lease_time'] == (m['leaseMs'] // 1000,)
            mask = str(ipaddress.IPv4Network('0.0.0.0/' + str(m['prefix'])).netmask)
            assert options['subnet_mask'] == (mask,)
            assert options.get('router', ()) == ((m['gateway'],) if 'gateway' in m else ())
            assert options.get('name_server', ()) == tuple(m['dns'])
            if m['leaseMs'] % 8000 == 0:
                assert options['renewal_time'] == (m['leaseMs'] // 2000,)
                assert options['rebinding_time'] == (m['leaseMs'] * 7 // 8000,)
        if kind == 'request' and m['clientIp'] != '0.0.0.0':
            assert 'requested_addr' not in options and 'server_id' not in options
            renewed |= packet[IP].dst == '192.0.2.2'
            rebound |= packet[IP].dst == '255.255.255.255'
        relay_request |= packet[UDP].sport == 67 and packet[UDP].dport == 67 and boot.op == 1
        relay_reply |= packet[UDP].sport == 67 and packet[UDP].dport == 67 and boot.op == 2
        backup_ack |= kind == 'ack' and packet[IP].src == '192.0.2.3'
    if scenario['name'] == 'local':
        assert set(messages) == set(types)
    else:
        assert renewed and rebound and backup_ack
    if scenario['name'] == 'relay':
        assert relay_request and relay_reply
    # Independent Wireshark dissection must identify every DHCP datagram and no
    # malformed frame. Compare its fields to Scapy and the native manifest.
    def run(*args):
        result = subprocess.run([tshark, '-n', '-r', str(path), *args], capture_output=True, text=True, check=True)
        return result.stdout
    assert not run('-Y', '_ws.malformed', '-T', 'fields', '-e', 'frame.number').strip()
    rows = run('-Y', 'dhcp', '-T', 'fields', '-e', 'frame.number', '-e', 'dhcp.id', '-e', 'dhcp.option.dhcp').splitlines()
    assert len(rows) == sum(messages.values())
    for row in rows:
        number, xid, message_type = row.split('\t')
        m = scenario['frames'][int(number) - 1]['dhcp']
        assert int(xid, 0) == int(m['transactionId'].removeprefix('dhcp-'))
        assert int(message_type) == types[m['type']]
    results.append({'name': scenario['name'], 'packets': len(packets), 'dhcp': dict(messages),
                    'wiresharkDhcpPackets': len(rows), 'malformed': 0})
report = {'generatedAt': datetime.now(timezone.utc).isoformat(), 'passed': True,
          'engineContract': manifest['engineContract'], 'engineSourceHash': manifest['engineSourceHash'],
          'decoders': ['Scapy', 'TShark'], 'checksums': dict(checked), 'scenarios': results}
(root / 'independent-captures.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
print(json.dumps(report))
