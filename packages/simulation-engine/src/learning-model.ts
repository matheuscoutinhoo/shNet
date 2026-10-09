import { z } from 'zod';
import { idSchema, ipv4Schema, portNumberSchema } from './schemas';
import { transportAddressSchema } from './protocols/tcp-model';
import { dnsNameSchema } from './protocols/dns-model';

const endpoint = { device: idSchema, port: idSchema };
const traffic = {
  device: idSchema,
  target: transportAddressSchema,
  vrf: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,32}$/)
    .optional(),
  scope: idSchema.optional(),
};
/** A finite, declarative vocabulary: definitions never execute uploaded code. */
export const learningPredicateSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('devices'),
      type: z.enum(['pc', 'server', 'switch', 'router']),
      minimum: z.number().int().min(1).max(24),
    })
    .strict(),
  z.object({ kind: z.literal('linked'), ...endpoint, peer: idSchema, peerPort: idSchema }).strict(),
  z
    .object({
      kind: z.literal('ipv4'),
      ...endpoint,
      address: ipv4Schema,
      prefix: z.number().int().min(0).max(32),
    })
    .strict(),
  z
    .object({
      kind: z.literal('vlan'),
      ...endpoint,
      vlan: z.number().int().min(1).max(4094),
      mode: z.enum(['access', 'trunk']),
    })
    .strict(),
  z.object({ kind: z.literal('dhcp'), ...endpoint }).strict(),
  z
    .object({
      kind: z.literal('ping'),
      ...traffic,
      expect: z.enum(['success', 'unreachable']).default('success'),
    })
    .strict(),
  z
    .object({
      kind: z.literal('tcp-echo'),
      ...traffic,
      destinationPort: portNumberSchema,
      text: z.string().min(1).max(1024),
    })
    .strict(),
  z
    .object({
      kind: z.literal('http'),
      ...traffic,
      destinationPort: portNumberSchema.default(80),
      path: z
        .string()
        .regex(/^\/[^\s\r\n]{0,255}$/)
        .default('/'),
      contains: z.string().min(1).max(512),
    })
    .strict(),
  z
    .object({
      kind: z.literal('dns'),
      device: idSchema,
      name: dnsNameSchema,
      type: z.enum(['A', 'AAAA', 'CNAME']),
      server: transportAddressSchema.optional(),
      value: z.string().min(1).max(253),
      secure: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      kind: z.literal('route'),
      device: idSchema,
      network: ipv4Schema,
      prefix: z.number().int().min(0).max(32),
      protocol: z.enum(['static', 'rip', 'ospf', 'bgp']),
      nextHop: ipv4Schema.optional(),
    })
    .strict(),
]);
export type LearningPredicate = z.infer<typeof learningPredicateSchema>;
export const learningObjectiveSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9_-]{1,48}$/),
    label: z.string().trim().min(1).max(180),
    hint: z.string().trim().max(1000).default(''),
    weight: z.number().int().min(1).max(20).default(1),
    predicate: learningPredicateSchema,
  })
  .strict();
export const challengeDefinitionSchema = z
  .object({
    schemaVersion: z.literal(1),
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().min(1).max(2000),
    objectives: z.array(learningObjectiveSchema).min(1).max(16),
  })
  .strict()
  .refine(
    (value) => new Set(value.objectives.map((o) => o.id)).size === value.objectives.length,
    'Identificadores de objetivos duplicados.'
  );
export type ChallengeDefinition = z.infer<typeof challengeDefinitionSchema>;
export interface LearningTaskResult {
  id: string;
  label: string;
  passed: boolean;
  weight: number;
  evidence: string;
}
export interface LearningEvaluation {
  tasks: LearningTaskResult[];
  passed: number;
  total: number;
  score: number;
  complete: boolean;
}
export interface ChallengeRecord {
  project_id: string;
  revision: number;
  definition: ChallengeDefinition;
  updated_at: string;
}
export interface LearningProgress {
  goal: string;
  revision: number;
  definition_revision: number;
  result: LearningEvaluation;
  best_score: number;
  completed: boolean;
  checked_at: string;
}
export interface TutorialProgress {
  step: number;
  total: number;
  complete: boolean;
  result: LearningEvaluation | null;
  revision: number;
  checked_at: string | null;
}
export interface LearningScore {
  score: number;
  completed: number;
  activities: number;
  sources: { labs: number; challenges: number; tutorials: number };
}

export const networkTutorial = [
  {
    id: 'equipment',
    title: 'Monte os extremos da LAN',
    instruction:
      'Adicione dois PCs e um switch pelo catálogo. Os PCs geram tráfego; o switch encaminha quadros usando endereços MAC.',
    panel: 'catalog',
    hint: 'Use o botão + nos perfis PC e Switch. Cada equipamento precisa de uma porta disponível.',
  },
  {
    id: 'cabling',
    title: 'Construa o caminho físico',
    instruction:
      'Conecte a porta de cada PC a uma porta diferente do mesmo switch. Deixe os cabos e as interfaces ativos.',
    panel: 'connections',
    hint: 'Abra Conectar. Escolha um PC e o switch para cada enlace de cobre.',
  },
  {
    id: 'addressing',
    title: 'Configure endereços na mesma rede',
    instruction:
      'Abra a configuração dos dois PCs e atribua IPv4 diferentes na mesma sub-rede, por exemplo 192.168.10.10/24 e 192.168.10.20/24.',
    panel: 'inspector',
    hint: 'Em uma LAN direta, gateway não é necessário. Confira a máscara e a VLAN das portas.',
  },
  {
    id: 'neighbor',
    title: 'Observe ARP e ICMP',
    instruction:
      'Execute ping entre os PCs e acompanhe ARP Request, ARP Reply, Echo Request e Echo Reply na linha do tempo. A validação envia um novo ping, sem reutilizar resultados antigos.',
    panel: 'timeline',
    hint: 'Um cabo ativo não basta: o endereço de destino precisa estar atribuído ao outro PC.',
  },
  {
    id: 'transport',
    title: 'Suba para a camada de transporte',
    instruction:
      'No segundo PC, habilite um serviço TCP echo na porta 7. O teste abre uma nova conexão, envia uma mensagem e verifica sua devolução pelo TCP da simulação.',
    panel: 'inspector',
    hint: 'Selecione o segundo PC, abra TCP / HTTP e habilite echo/7. SYN, SYN-ACK e ACK precedem os dados.',
  },
] as const;
