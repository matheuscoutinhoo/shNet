import { z } from 'zod';
import { wlcConfigSchema, wtpConfigSchema } from './protocols/capwap-model';
import { meshConfigSchema } from './protocols/mesh-model';
import { idsConfigSchema } from './protocols/ids-model';
import {
  eapServerConfigSchema,
  eapAuthenticatorConfigSchema,
  eapSupplicantConfigSchema,
} from './protocols/enterprise-model';
import { proxyConfigSchema, printerConfigSchema, brokerConfigSchema } from './protocols/applications-model';
import { phoneConfigSchema } from './protocols/voice-model';
import { dnsResolverSchema, dnssecZoneSchema } from './protocols/dns-model';
import { dhcpSnoopingConfigSchema } from './protocols/dhcp-snooping-model';
import { poeSupplySchema, poeDeviceSchema } from './devices/hardware-model';
import { multiSpanningTreeConfigSchema } from './model';
import { ospfConfigSchema } from './protocols/ospf-model';
import { ripConfigSchema } from './protocols/rip-model';
import {
  dhcp6ServerConfigSchema,
  dhcp6ClientConfigSchema,
  dhcp6RelayConfigSchema,
} from './protocols/dhcp6-model';
import { udp6ServiceSchema } from './protocols/udp6-model';
import { qosConfigSchema } from './protocols/qos-model';
import { mplsConfigSchema } from './protocols/mpls-model';
import { vxlanConfigSchema } from './protocols/vxlan-model';
import {
  aaaServerConfigSchema,
  aaaClientSchema,
  dot1xConfigSchema,
  supplicantConfigSchema,
} from './protocols/aaa-model';
import { remoteConfigSchema, automationConfigSchema } from './protocols/remote-model';
import { remoteInputSchema } from './protocols/remote-wire';
import {
  telemetryConfigSchema,
  collectorConfigSchema,
  clockConfigSchema,
  ntpConfigSchema,
} from './protocols/telemetry-model';
import { inspectionConfigSchema } from './protocols/inspection-model';
import { sdwanPolicySchema, sdwanControllerSchema } from './protocols/tunnel-model';
export const configurationSchemas = {
  advancedNetwork: {
    wlc: wlcConfigSchema,
    wtp: wtpConfigSchema,
    mesh: meshConfigSchema,
    ids: idsConfigSchema,
    eapServer: eapServerConfigSchema,
    eapAuthenticator: eapAuthenticatorConfigSchema,
    eapSupplicant: eapSupplicantConfigSchema,
  },
  applications: {
    proxy: proxyConfigSchema,
    phone: phoneConfigSchema,
    printer: printerConfigSchema,
    broker: brokerConfigSchema,
  },
  dnsSecurity: z.object({ resolver: dnsResolverSchema, zones: z.array(dnssecZoneSchema) }).strict(),
  dhcpProtection: dhcpSnoopingConfigSchema,
  hardware: z
    .object({
      supply: poeSupplySchema.omit({ allocations: true }),
      load: poeDeviceSchema.pick({ required: true, class: true, watts: true }),
    })
    .strict(),
  stp: multiSpanningTreeConfigSchema,
  ospf: ospfConfigSchema,
  rip: ripConfigSchema,
  dhcp6: {
    client: dhcp6ClientConfigSchema,
    server: dhcp6ServerConfigSchema,
    relay: dhcp6RelayConfigSchema,
    udp: udp6ServiceSchema,
  },
  qos: qosConfigSchema,
  mpls: mplsConfigSchema,
  vxlan: vxlanConfigSchema,
  aaa: {
    server: aaaServerConfigSchema,
    client: aaaClientSchema,
    dot1x: dot1xConfigSchema,
    supplicant: supplicantConfigSchema,
  },
  remote: {
    server: remoteConfigSchema,
    request: remoteInputSchema,
    automation: automationConfigSchema,
    telemetry: telemetryConfigSchema,
    collector: collectorConfigSchema,
    clock: clockConfigSchema,
    ntp: ntpConfigSchema,
  },
  inspection: inspectionConfigSchema,
  sdwanPolicies: z.array(sdwanPolicySchema),
  sdwanController: sdwanControllerSchema,
};
