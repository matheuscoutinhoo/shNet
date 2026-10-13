import type { TemplateId } from '@shlab/engine';

export const templateCategories: Record<TemplateId, string> = {
  'enterprise-datacenter': 'Datacenter',
  factory: 'Industrial',
  empty: 'Fundamentos',
  lan: 'Fundamentos',
  routed: 'Roteamento',
  static: 'Roteamento',
  broken: 'Roteamento',
  bgp: 'Roteamento',
  ospf: 'Roteamento',
  rip: 'Roteamento',
  dhcp: 'Serviços',
  'dhcp-relay': 'Serviços',
  dns: 'Serviços',
  tcp: 'Serviços',
  vlan: 'Switching',
  subinterfaces: 'Switching',
  svi: 'Switching',
  lacp: 'Switching',
  rstp: 'Switching',
  nat: 'Segurança',
  inspection: 'Segurança',
  'firewall-zones': 'Segurança',
  aaa: 'Segurança',
  enterprise: 'Segurança',
  ipv6: 'IPv6',
  'ipv6-services': 'IPv6',
  wireless: 'Wireless',
  vpn: 'VPN',
  sdwan: 'SD-WAN',
  vrrp: 'Redundância',
  'vrrp-track': 'Redundância',
  vrf: 'Virtualização',
  vxlan: 'Virtualização',
  evpn: 'EVPN',
  mpls: 'MPLS',
  qos: 'QoS',
  automation: 'Automação',
  management: 'Automação',
};

export const searchText = (value: string) =>
  value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase('pt-BR')
    .trim();
