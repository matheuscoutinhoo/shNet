"""Independent wire checks for the ARP suppression and service-health examples."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from scapy.all import ARP, Ether, IP, TCP, UDP, VXLAN, rdpcap

root = Path(sys.argv[1] if len(sys.argv) > 1 else 'artifacts/evpn-arp-2026-10-15')
tshark = os.environ.get('TSHARK_PATH') or shutil.which('tshark')
if not tshark and os.name == 'nt':
    candidate = Path(os.environ.get('ProgramFiles', 'C:/Program Files')) / 'Wireshark/tshark.exe'
    if candidate.is_file():
        tshark = str(candidate)
if not tshark:
    raise RuntimeError('TShark is required.')
summary = []
for case in json.loads((root / 'scenarios.json').read_text(encoding='utf-8'))['cases']:
    file = root / (case['kind'] + '.pcap')
    packets = rdpcap(str(file))
    assert len(packets) == case['packets']
    checksums = 0
    for packet in packets:
        for layer in [IP, TCP, UDP]:
            index = 1
            while packet.getlayer(layer, index) is not None:
                old = packet.getlayer(layer, index).chksum
                copy = packet.copy()
                del copy.getlayer(layer, index).chksum
                assert Ether(bytes(copy)).getlayer(layer, index).chksum == old
                checksums += 1
                index += 1
    current = [p for p in packets if float(p.time) >= 6]
    target = '10.50.0.99' if case['kind'] == 'unknown-address' else '10.50.0.20'
    replies = [p for p in current if ARP in p and IP not in p and p[ARP].op == 2 and p[ARP].psrc == target and p[ARP].pdst == '10.50.0.10']
    broadcasts = [p for p in current if VXLAN in p and ARP in p[VXLAN] and p[ARP].op == 1 and p[ARP].pdst == target]
    resets = [p for p in current if TCP in p and p[TCP].flags.R and p[IP].src == '10.50.0.20']
    if case['kind'] == 'unknown-address':
        assert not replies and broadcasts
    else:
        assert replies and not broadcasts
        if case['kind'] == 'application-stopped':
            assert resets
        else:
            assert any(TCP in p and b'overlay VXLAN' in bytes(p[TCP].payload) for p in current)
    malformed = subprocess.run([tshark, '-r', str(file), '-Y', '_ws.malformed', '-T', 'fields', '-e', 'frame.number'], check=True, capture_output=True, text=True).stdout
    assert not malformed.strip(), malformed
    summary.append({'case': case['kind'], 'packets': len(packets), 'checksums': checksums,
                    'localArpReplies': len(replies), 'overlayArpRequests': len(broadcasts),
                    'resetsFromService': len(resets), 'malformed': 0, 'passed': True})
(root / 'independent-captures.json').write_text(json.dumps({'decoder': 'Scapy + TShark', 'cases': summary}, indent=2) + '\n', encoding='utf-8')
print(json.dumps({'cases': summary}))
