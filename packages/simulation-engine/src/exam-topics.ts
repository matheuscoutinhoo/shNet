import type { TemplateId } from './catalog-templates';
import type { LabId } from './catalog-labs';

/**
 * Exam blueprints and the topics each template or lab exercises. Topic wording follows the
 * published Cisco exam topics (CCNA 200-301 v1.1, CCNP ENCOR 350-401 v1.1, ENARSI 300-410
 * v1.1), shortened where long. Only topics a lab actually exercises in the simulator are mapped.
 * @i18n-skip Official exam wording is shown in English in every interface language.
 */
export type ExamId = 'ccna' | 'encor' | 'enarsi';
export const EXAMS: Record<ExamId, { name: string; code: string; version: string }> = {
  ccna: { name: 'CCNA', code: '200-301', version: 'v1.1' },
  encor: { name: 'CCNP ENCOR', code: '350-401', version: 'v1.1' },
  enarsi: { name: 'CCNP ENARSI', code: '300-410', version: 'v1.1' },
};
export const EXAM_DOMAINS: Record<ExamId, Record<string, string>> = {
  ccna: {
    '1': 'Network Fundamentals (20%)',
    '2': 'Network Access (20%)',
    '3': 'IP Connectivity (25%)',
    '4': 'IP Services (10%)',
    '5': 'Security Fundamentals (15%)',
    '6': 'Automation and Programmability (10%)',
  },
  encor: {
    '1': 'Architecture (15%)',
    '2': 'Virtualization (10%)',
    '3': 'Infrastructure (30%)',
    '4': 'Network Assurance (10%)',
    '5': 'Security (20%)',
    '6': 'Automation (15%)',
  },
  enarsi: {
    '1': 'Layer 3 Technologies (35%)',
    '2': 'VPN Technologies (20%)',
    '3': 'Infrastructure Security (20%)',
    '4': 'Infrastructure Services (25%)',
  },
};
export interface ExamTopic {
  id: string;
  exam: ExamId;
  number: string;
  title: string;
}
const topics = (exam: ExamId, list: [number: string, title: string][]): ExamTopic[] =>
  list.map(([number, title]) => ({ id: exam + '-' + number, exam, number, title }));

export const EXAM_TOPICS: ExamTopic[] = [
  ...topics('ccna', [
    ['1.1', 'Explain the role and function of network components'],
    ['1.2', 'Describe characteristics of network topology architectures'],
    ['1.3', 'Compare physical interface and cabling types'],
    ['1.4', 'Identify interface and cable issues (collisions, errors, mismatch duplex, and/or speed)'],
    ['1.5', 'Compare TCP to UDP'],
    ['1.6', 'Configure and verify IPv4 addressing and subnetting'],
    ['1.7', 'Describe private IPv4 addressing'],
    ['1.8', 'Configure and verify IPv6 addressing and prefix'],
    ['1.9', 'Describe IPv6 address types'],
    ['1.10', 'Verify IP parameters for Client OS (Windows, Mac OS, Linux)'],
    ['1.11', 'Describe wireless principles'],
    ['1.12', 'Explain virtualization fundamentals (server virtualization, containers, and VRFs)'],
    ['1.13', 'Describe switching concepts'],
    ['2.1', 'Configure and verify VLANs (normal range) spanning multiple switches'],
    ['2.2', 'Configure and verify interswitch connectivity (trunk ports, 802.1Q, native VLAN)'],
    ['2.3', 'Configure and verify Layer 2 discovery protocols (Cisco Discovery Protocol and LLDP)'],
    ['2.4', 'Configure and verify (Layer 2/Layer 3) EtherChannel (LACP)'],
    ['2.5', 'Interpret basic operations of Rapid PVST+ Spanning Tree Protocol'],
    ['2.6', 'Describe Cisco Wireless Architectures and AP modes'],
    ['2.7', 'Describe physical infrastructure connections of WLAN components'],
    ['2.8', 'Describe network device management access (Telnet, SSH, HTTP, HTTPS, console, TACACS+/RADIUS)'],
    ['2.9', 'Interpret the wireless LAN GUI configuration for client connectivity'],
    ['3.1', 'Interpret the components of routing table'],
    ['3.2', 'Determine how a router makes a forwarding decision by default'],
    ['3.3', 'Configure and verify IPv4 and IPv6 static routing'],
    ['3.4', 'Configure and verify single area OSPFv2'],
    ['3.5', 'Describe the purpose, functions, and concepts of first hop redundancy protocols'],
    ['4.1', 'Configure and verify inside source NAT using static and pools'],
    ['4.2', 'Configure and verify NTP operating in a client and server mode'],
    ['4.3', 'Explain the role of DHCP and DNS within the network'],
    ['4.4', 'Explain the function of SNMP in network operations'],
    ['4.5', 'Describe the use of syslog features including facilities and severity levels'],
    ['4.6', 'Configure and verify DHCP client and relay'],
    ['4.7', 'Explain the forwarding per-hop behavior (PHB) for QoS'],
    ['4.8', 'Configure network devices for remote access using SSH'],
    ['4.9', 'Describe the capabilities and functions of TFTP/FTP in the network'],
    ['5.1', 'Define key security concepts (threats, vulnerabilities, exploits, and mitigation techniques)'],
    ['5.2', 'Describe security program elements (user awareness, training, and physical access control)'],
    ['5.3', 'Configure and verify device access control using local passwords'],
    ['5.4', 'Describe security password policies elements'],
    ['5.5', 'Describe IPsec remote access and site-to-site VPNs'],
    ['5.6', 'Configure and verify access control lists'],
    [
      '5.7',
      'Configure and verify Layer 2 security features (DHCP snooping, dynamic ARP inspection, port security)',
    ],
    ['5.8', 'Compare authentication, authorization, and accounting concepts'],
    ['5.9', 'Describe wireless security protocols (WPA, WPA2, and WPA3)'],
    ['5.10', 'Configure and verify WLAN within the GUI using WPA2 PSK'],
    ['6.1', 'Explain how automation impacts network management'],
    ['6.2', 'Compare traditional networks with controller-based networking'],
    ['6.3', 'Describe controller-based, software defined architecture (overlay, underlay, and fabric)'],
    ['6.4', 'Explain AI (generative and predictive) and machine learning in network operations'],
    [
      '6.5',
      'Describe characteristics of REST-based APIs (authentication types, CRUD, HTTP verbs, and data encoding)',
    ],
    [
      '6.6',
      'Recognize the capabilities of configuration management mechanisms, such as Ansible and Terraform',
    ],
    ['6.7', 'Recognize components of JSON-encoded data'],
  ]),
  ...topics('encor', [
    [
      '1.1',
      'Enterprise network design (2-tier, 3-tier, fabric, cloud) and high availability (redundancy, FHRP, SSO)',
    ],
    ['1.2', 'Wireless network design principles'],
    ['1.3', 'Working principles of the Cisco SD-WAN solution'],
    ['1.4', 'Working principles of the Cisco SD-Access solution'],
    ['1.5', 'Interpret wired and wireless QoS configurations'],
    ['1.6', 'Hardware and software switching mechanisms (CEF, CAM, TCAM, FIB, RIB, adjacency tables)'],
    ['2.1', 'Device virtualization technologies (hypervisors, virtual machines, virtual switching)'],
    ['2.2', 'Configure and verify data path virtualization technologies (VRF, GRE and IPsec tunneling)'],
    ['2.3', 'Network virtualization concepts (LISP, VXLAN)'],
    ['3.1.a', 'Troubleshoot static and dynamic 802.1q trunking protocols'],
    ['3.1.b', 'Troubleshoot static and dynamic EtherChannels'],
    ['3.1.c', 'Configure and verify common Spanning Tree Protocols (RSTP, MST) and enhancements'],
    ['3.2.a', 'Compare routing concepts of EIGRP and OSPF'],
    ['3.2.b', 'Configure simple OSPFv2/v3 environments (multiple areas, summarization, filtering)'],
    ['3.2.c', 'Configure and verify eBGP between directly connected neighbors'],
    ['3.2.d', 'Describe policy-based routing'],
    ['3.3', 'Wireless: RF concepts, AP modes, AP join, roaming and WLAN troubleshooting'],
    ['3.4.a', 'Interpret network time protocol configurations such as NTP and PTP'],
    ['3.4.b', 'Configure NAT/PAT'],
    ['3.4.c', 'Configure first hop redundancy protocols, such as HSRP and VRRP'],
    ['3.4.d', 'Describe multicast protocols (RPF check, PIM SM, IGMP v2/v3, SSM, bidir, MSDP)'],
    ['4.1', 'Diagnose network problems using debugs, traceroute, ping, SNMP, and syslog'],
    ['4.2', 'Configure and verify Flexible NetFlow'],
    ['4.3', 'Configure SPAN/RSPAN/ERSPAN'],
    ['4.4', 'Configure and verify IPSLA'],
    [
      '4.5',
      'Describe Cisco Catalyst Center (DNA Center) workflows for configuration, monitoring, and management',
    ],
    ['4.6', 'Configure and verify NETCONF and RESTCONF'],
    ['5.1.a', 'Device access control: lines and local user authentication'],
    ['5.1.b', 'Device access control: authentication and authorization using AAA'],
    ['5.2.a', 'Infrastructure security: ACLs'],
    ['5.2.b', 'Infrastructure security: CoPP'],
    ['5.3', 'Describe REST API security'],
    ['5.4', 'Configure and verify wireless security features (802.1X, WebAuth, PSK, EAPOL)'],
    ['5.5', 'Components of network security design (threat defense, NGFW, TrustSec, 802.1X/MAB/WebAuth)'],
    ['6.1', 'Interpret basic Python components and scripts'],
    ['6.2', 'Construct valid JSON-encoded files'],
    ['6.3', 'Principles and benefits of a data modeling language, such as YANG'],
    ['6.4', 'Describe APIs for Cisco Catalyst Center (DNA Center) and SD-WAN Manager (vManage)'],
    ['6.5', 'Interpret REST API response codes and payloads (Catalyst Center/DNA Center, RESTCONF)'],
    ['6.6', 'Construct an EEM applet to automate configuration, troubleshooting, or data collection'],
    ['6.7', 'Compare agent vs. agentless orchestration tools (Chef, Puppet, Ansible, SaltStack)'],
  ]),
  ...topics('enarsi', [
    ['1.1', 'Troubleshoot administrative distance'],
    ['1.2', 'Troubleshoot route map for any routing protocol (attributes, tagging, filtering)'],
    ['1.3', 'Troubleshoot loop prevention mechanisms (filtering, tagging, split horizon, route poisoning)'],
    ['1.4', 'Troubleshoot redistribution between any routing protocols or routing sources'],
    ['1.5', 'Troubleshoot manual and auto-summarization with any routing protocol'],
    ['1.6', 'Configure and verify policy-based routing'],
    ['1.7', 'Configure and verify VRF-Lite'],
    ['1.8', 'Describe Bidirectional Forwarding Detection'],
    ['1.9', 'Troubleshoot EIGRP (classic and named mode)'],
    ['1.10', 'Troubleshoot OSPF (v2/v3)'],
    ['1.11', 'Troubleshoot BGP (internal and external)'],
    ['2.1', 'Describe MPLS operations (LSR, LDP, label switching, LSP)'],
    ['2.2', 'Describe MPLS Layer 3 VPN'],
    ['2.3', 'Configure and verify DMVPN (single hub)'],
    ['3.1', 'Troubleshoot device security using IOS AAA (TACACS+, RADIUS, local database)'],
    ['3.2', 'Troubleshoot router security features (IPv4 ACLs, IPv6 traffic filter, uRPF)'],
    ['3.3', 'Troubleshoot control plane policing (CoPP)'],
    ['3.4', 'Describe IPv6 First Hop security features'],
    ['4.1', 'Troubleshoot device management (console, VTY, Telnet, HTTP, HTTPS, SSH, SCP, (T)FTP)'],
    ['4.2', 'Troubleshoot SNMP (v2c, v3)'],
    ['4.3', 'Troubleshoot network problems using logging (local, syslog, debugs, timestamps)'],
    ['4.4', 'Troubleshoot IPv4 and IPv6 DHCP (client, IOS DHCP server, relay, options)'],
    ['4.5', 'Troubleshoot network performance issues using IP SLA (jitter, tracking objects, delay)'],
    ['4.6', 'Troubleshoot NetFlow (v5, v9, Flexible NetFlow)'],
    ['4.7', 'Troubleshoot network problems using Cisco Catalyst Center (DNA Center) assurance'],
  ]),
];

/** Topics exercised by each template and guided lab. */
export const EXAM_MAP: Partial<Record<TemplateId | LabId, string[]>> = {
  lan: ['ccna-1.1', 'ccna-1.6', 'ccna-1.10', 'ccna-1.13'],
  routed: ['ccna-1.6', 'ccna-3.1', 'ccna-3.2'],
  static: ['ccna-3.1', 'ccna-3.2', 'ccna-3.3'],
  broken: ['ccna-1.4', 'ccna-3.1', 'encor-4.1'],
  dhcp: ['ccna-1.10', 'ccna-4.3', 'ccna-4.6', 'enarsi-4.4'],
  dns: ['ccna-1.10', 'ccna-4.3'],
  'dhcp-relay': ['ccna-4.3', 'ccna-4.6', 'enarsi-4.4'],
  tcp: ['ccna-1.5', 'ccna-4.1'],
  vlan: ['ccna-1.13', 'ccna-2.1', 'ccna-2.2', 'encor-3.1.a'],
  subinterfaces: ['ccna-2.1', 'ccna-2.2', 'encor-3.1.a'],
  svi: ['ccna-2.1', 'ccna-3.1', 'encor-1.6'],
  lacp: ['ccna-2.4', 'encor-3.1.b'],
  rstp: ['ccna-2.5', 'encor-3.1.c'],
  ospf: ['ccna-3.1', 'ccna-3.2', 'ccna-3.4', 'encor-3.2.a', 'encor-3.2.b', 'enarsi-1.10'],
  rip: ['ccna-3.1', 'ccna-3.2', 'enarsi-1.1', 'enarsi-1.3'],
  bgp: ['encor-3.2.c', 'enarsi-1.2', 'enarsi-1.11'],
  vrrp: ['ccna-3.5', 'encor-1.1', 'encor-3.4.c'],
  'vrrp-track': ['ccna-3.5', 'encor-3.4.c', 'enarsi-4.5'],
  nat: ['ccna-1.7', 'ccna-4.1', 'ccna-5.6', 'encor-3.4.b', 'encor-5.2.a'],
  'firewall-zones': ['ccna-5.1', 'encor-5.5'],
  inspection: ['ccna-5.1', 'encor-5.5'],
  aaa: ['ccna-2.8', 'ccna-5.8', 'encor-5.1.b', 'encor-5.5', 'enarsi-3.1'],
  enterprise: ['ccna-5.8', 'ccna-5.9', 'encor-5.4', 'encor-5.5'],
  wireless: ['ccna-1.11', 'ccna-2.6', 'ccna-5.9', 'ccna-5.10', 'encor-3.3', 'encor-5.4'],
  ipv6: ['ccna-1.8', 'ccna-1.9'],
  'ipv6-services': ['ccna-1.8', 'ccna-1.9', 'ccna-1.5', 'enarsi-4.4'],
  vrf: ['ccna-1.12', 'encor-2.2', 'enarsi-1.7'],
  vpn: ['ccna-5.5', 'encor-2.2'],
  sdwan: ['ccna-6.2', 'ccna-6.3', 'encor-1.3'],
  vxlan: ['ccna-6.3', 'encor-2.3'],
  evpn: ['ccna-6.3', 'encor-2.3', 'encor-3.2.c'],
  mpls: ['enarsi-2.1'],
  qos: ['ccna-4.7', 'encor-1.5'],
  management: ['ccna-4.4', 'ccna-4.5', 'encor-4.1', 'enarsi-4.2', 'enarsi-4.3'],
  automation: ['ccna-4.2', 'ccna-6.1', 'ccna-6.5', 'ccna-6.7', 'encor-3.4.a', 'encor-4.6', 'encor-6.3'],
  'enterprise-resilient': ['ccna-1.2', 'ccna-2.1', 'ccna-2.4', 'ccna-2.5', 'ccna-3.5', 'encor-1.1'],
  'enterprise-datacenter': [
    'ccna-1.2',
    'ccna-2.1',
    'ccna-2.4',
    'ccna-3.5',
    'encor-1.1',
    'encor-2.3',
    'encor-3.1.c',
  ],
  'factory-resilient': ['ccna-1.2', 'ccna-2.1', 'ccna-3.5', 'encor-1.1'],
  factory: ['ccna-1.2', 'ccna-2.1', 'ccna-3.5', 'ccna-4.3'],
  'service-ha': ['ccna-3.5', 'ccna-4.3', 'encor-1.1', 'encor-3.4.c', 'enarsi-4.5'],
  'dhcp-ha': ['ccna-4.3', 'encor-1.1'],
  'dual-access': ['encor-1.1'],
  'lan-foundations': ['ccna-1.6', 'ccna-1.10', 'ccna-1.13'],
  'routing-repair': ['ccna-1.4', 'ccna-3.1', 'ccna-3.2', 'encor-4.1'],
  'dhcp-basics': ['ccna-1.10', 'ccna-4.3', 'ccna-4.6'],
  'vlan-segmentation': ['ccna-2.1', 'ccna-2.2', 'encor-3.1.a'],
  'nat-boundary': ['ccna-4.1', 'ccna-5.6', 'encor-3.4.b', 'encor-5.2.a'],
  'rstp-failover': ['ccna-2.5', 'encor-3.1.c'],
  'bgp-repair': ['encor-3.2.c', 'enarsi-1.11'],
  'ospf-repair': ['ccna-3.4', 'encor-3.2.b', 'enarsi-1.10'],
  'rip-repair': ['ccna-3.1', 'enarsi-1.3'],
  'svi-repair': ['ccna-2.1', 'ccna-3.1'],
  'vrf-isolation': ['ccna-1.12', 'encor-2.2', 'enarsi-1.7'],
  'lacp-repair': ['ccna-2.4', 'encor-3.1.b'],
  'gateway-tracking': ['ccna-3.5', 'encor-3.4.c', 'enarsi-4.5'],
  'ipv6-slaac': ['ccna-1.8', 'ccna-1.9'],
  'wireless-repair': ['ccna-5.9', 'ccna-5.10', 'encor-5.4'],
  'vpn-repair': ['ccna-5.5', 'encor-2.2'],
  'sdwan-repair': ['ccna-6.3', 'encor-1.3'],
  'qos-repair': ['ccna-4.7', 'encor-1.5'],
  'mpls-repair': ['enarsi-2.1'],
  'evpn-repair': ['encor-2.3', 'encor-3.2.c'],
  'aaa-repair': ['ccna-5.8', 'encor-5.1.b', 'encor-5.5', 'enarsi-3.1'],
  'inspection-repair': ['encor-5.5'],
  'automation-repair': ['ccna-6.5', 'ccna-6.7', 'encor-4.6', 'encor-6.3'],
};

const byId = new Map(EXAM_TOPICS.map((topic) => [topic.id, topic]));

/** Exam topics of a template or lab, in blueprint order. */
export function examTopicsFor(id: string, exam?: ExamId) {
  return (EXAM_MAP[id as TemplateId | LabId] ?? [])
    .map((topic) => byId.get(topic)!)
    .filter((topic) => !exam || topic.exam === exam)
    .sort((a, b) => EXAM_TOPICS.indexOf(a) - EXAM_TOPICS.indexOf(b));
}

/** Every topic of an exam with the templates and labs that exercise it. */
export function examCoverage(exam: ExamId) {
  return EXAM_TOPICS.filter((topic) => topic.exam === exam).map((topic) => ({
    topic,
    domain: EXAM_DOMAINS[exam][topic.number.split('.')[0]],
    items: Object.entries(EXAM_MAP)
      .filter(([, list]) => list!.includes(topic.id))
      .map(([id]) => id as TemplateId | LabId),
  }));
}
