"""Offline validation with Scapy, independent of the TypeScript codecs."""
from pathlib import Path
from scapy.all import Ether, IP, IPv6, TCP, UDP, DNS, rdpcap
from scapy.layers.dhcp6 import DHCP6_RelayReply, DHCP6_Reply, DHCP6OptIAPrefix
from scapy.layers.inet6 import ICMPv6ND_NS

root = Path('.data/captures')
packets = rdpcap(str(root / 'http.pcap'))
assert any(TCP in p and p[TCP].flags.S and ('Timestamp', (0, 0)) in p[TCP].options for p in packets)
assert any(b'HTTP bin' in bytes(p[TCP].payload) for p in packets if TCP in p)
checked = 0
for p in packets:
    if IP in p:
        original = p[IP].chksum
        copy = p.copy()
        del copy[IP].chksum
        assert Ether(bytes(copy))[IP].chksum == original
    if TCP in p:
        original = p[TCP].chksum
        copy = p.copy()
        del copy[TCP].chksum
        assert Ether(bytes(copy))[TCP].chksum == original
        checked += 1
relay = Ether((root / 'relay.ethernet').read_bytes())
assert IPv6 in relay and UDP in relay and DHCP6_RelayReply in relay
assert relay[DHCP6_RelayReply].hopcount == 1
assert relay.getlayer(DHCP6_RelayReply, 2).hopcount == 0
assert relay[DHCP6_Reply].trid == 0x123456
assert relay[DHCP6OptIAPrefix].prefix == '2001:db8:100::'
original = relay[UDP].chksum
copy = relay.copy()
del copy[UDP].chksum
assert Ether(bytes(copy))[UDP].chksum == original
dns = Ether((root / 'dns.ethernet').read_bytes())
assert dns[DNS].qd.qname == b'www.example.com.'
nd = Ether((root / 'nd.ethernet').read_bytes())
assert nd[ICMPv6ND_NS].tgt == '2001:db8::2' and nd[IPv6].hlim == 255
print(f'Scapy validated {len(packets)} PCAP packets, {checked} TCP checksums, DNS, IPv6 ND and nested DHCPv6 relay.')
