import { advancedLabs } from './catalog-advanced-labs';
export const labs = [
  ...advancedLabs,
  {
    id: 'lan-foundations',
    name: 'Primeira LAN',
    category: 'Fundamentos',
    difficulty: 'Iniciante',
    template: 'empty',
    objective: 'Conecte dois PCs por um switch, configure IPv4 e valide a comunicação.',
  },
  {
    id: 'routing-repair',
    name: 'Reconecte as sub-redes',
    category: 'Roteamento',
    difficulty: 'Intermediário',
    template: 'broken',
    objective: 'Diagnostique o enlace indisponível e recupere a comunicação de ponta a ponta.',
  },
  {
    id: 'dhcp-basics',
    name: 'Concessões em operação',
    category: 'Serviços',
    difficulty: 'Iniciante',
    template: 'dhcp',
    objective: 'Configure os clientes para obter endereço por DHCP e valide os leases.',
  },
  {
    id: 'vlan-segmentation',
    name: 'VLAN 20 de ponta a ponta',
    category: 'Switching',
    difficulty: 'Intermediário',
    template: 'vlan',
    objective: 'Crie VLAN 20 nos switches, configure access/trunk e mantenha a conectividade.',
  },
  {
    id: 'nat-boundary',
    name: 'Tradução na borda',
    category: 'Segurança',
    difficulty: 'Intermediário',
    template: 'nat',
    objective: 'Implemente NAT e libere ICMP, bloqueando consultas DNS com uma ACL.',
  },
  {
    id: 'rstp-failover',
    name: 'Caminho resiliente',
    category: 'Switching',
    difficulty: 'Intermediário',
    template: 'rstp',
    objective: 'Mantenha comunicação após a queda de um uplink sem formar um loop Ethernet.',
  },
] as const;
export type LabId = (typeof labs)[number]['id'];
