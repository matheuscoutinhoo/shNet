import { z } from 'zod';
import { ipv4Schema } from '../schemas';

const name = z.string().regex(/^[\w.+@-]{1,64}$/);
const level = z.number().int().min(0).max(7);
const port = z.number().int().min(1).max(65535);
// AAA method: "group NAME" (tacacs+, radius or a server group), local, enable, line or none.
const methods = z
  .array(z.string().regex(/^(?:group [\w.+-]{1,32}|local|local-case|enable|line|none|krb5)$/))
  .min(1)
  .max(5);
const aaaList = z.string().regex(/^[\w.-]{1,32}$/);
export const IOS_LINE_KINDS = ['con', 'aux', 'vty'] as const;
export const iosLineSchema = z
  .object({
    kind: z.enum(IOS_LINE_KINDS),
    first: z.number().int().min(0).max(1500),
    last: z.number().int().min(0).max(1500),
    execTimeout: z
      .object({ minutes: z.number().int().min(0).max(35791), seconds: z.number().int().min(0).max(2147483) })
      .strict()
      .optional(),
    loggingSynchronous: z.boolean().optional(),
    // "login" (line password), "login local" or "login authentication LIST" (AAA).
    login: z.union([z.enum(['line', 'local']), z.object({ list: aaaList }).strict()]).optional(),
    noLogin: z.boolean().optional(),
    password: z.string().min(1).max(128).optional(),
    transportInput: z
      .array(z.enum(['ssh', 'telnet', 'none', 'all']))
      .max(3)
      .optional(),
    transportOutput: z
      .array(z.enum(['ssh', 'telnet', 'none', 'all']))
      .max(3)
      .optional(),
    accessClass: z
      .object({ acl: z.string().regex(/^[\w-]{1,64}$/), vrfAlso: z.boolean() })
      .strict()
      .optional(),
    privilege: z.number().int().min(0).max(15).optional(),
    authorizationExec: aaaList.optional(),
    accountingExec: aaaList.optional(),
    historySize: z.number().int().min(0).max(256).optional(),
    noExec: z.boolean().optional(),
  })
  .strict();
export const iosAaaServerSchema = z
  .object({
    kind: z.enum(['tacacs', 'radius']),
    name,
    address: ipv4Schema.optional(),
    key: z.string().min(1).max(128).optional(),
    port: port.optional(),
    authPort: port.optional(),
    acctPort: port.optional(),
    timeout: z.number().int().min(1).max(1000).optional(),
    retransmit: z.number().int().min(0).max(100).optional(),
    singleConnection: z.boolean().optional(),
    // Defined with the legacy "tacacs-server host" / "radius-server host" syntax (named by address).
    legacy: z.boolean().optional(),
  })
  .strict();
export const iosSnmpHostSchema = z
  .object({
    address: ipv4Schema,
    version: z.enum(['1', '2c', '3']),
    security: z.enum(['noauth', 'auth', 'priv']).optional(),
    community: z.string().regex(/^[\w@.-]{1,64}$/),
    informs: z.boolean().optional(),
  })
  .strict();
export const iosSnmpUserSchema = z
  .object({
    name,
    group: name,
    auth: z
      .object({ algorithm: z.enum(['md5', 'sha']), key: z.string().min(8).max(64) })
      .strict()
      .optional(),
    priv: z
      .object({
        algorithm: z.enum(['des', '3des', 'aes 128', 'aes 192', 'aes 256']),
        key: z.string().min(8).max(64),
      })
      .strict()
      .optional(),
  })
  .strict();
export const iosSystemSchema = z
  .object({
    // "service password-encryption": reversible secrets are shown as type 7.
    passwordEncryption: z.boolean().optional(),
    timezone: z
      .object({
        name: z.string().regex(/^[\w+-]{1,16}$/),
        hours: z.number().int().min(-23).max(23),
        minutes: z.number().int().min(0).max(59).default(0),
      })
      .strict()
      .optional(),
    archive: z
      .object({
        path: z.string().min(1).max(160).default('flash:/archive'),
        maximum: z.number().int().min(1).max(14).default(14),
        writeMemory: z.boolean().default(false),
        copies: z
          .array(
            z
              .object({
                at: z.number().finite().nonnegative(),
                name: z.string().max(160),
                configuration: z.string().max(65536),
              })
              .strict()
          )
          .max(14)
          .default([]),
      })
      .strict()
      .optional(),
    // "service timestamps log|debug ...": the options after the keyword, as typed.
    timestamps: z
      .object({
        log: z.string().max(80).optional(),
        debug: z.string().max(80).optional(),
      })
      .strict()
      .optional(),
    // Global "no service X" / "service X" hardening switches (pad, tcp-keepalives-in, config...).
    services: z.record(z.string().regex(/^[\w-]{1,32}$/), z.boolean()).optional(),
    domainName: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,63}$/)
      .optional(),
    domainLookup: z.boolean().optional(),
    users: z
      .array(
        z
          .object({
            name,
            privilege: z.number().int().min(0).max(15).optional(),
            // Exactly one of: a hashed secret ("$9$...", "$8$...") or a reversible password.
            secret: z.string().max(160).optional(),
            password: z.string().min(1).max(128).optional(),
          })
          .strict()
      )
      .max(64)
      .optional(),
    aaa: z
      .object({
        newModel: z.boolean(),
        authentication: z
          .array(
            z.object({ kind: z.enum(['login', 'enable', 'dot1x', 'ppp']), list: aaaList, methods }).strict()
          )
          .max(16),
        authorization: z
          .array(
            z
              .object({
                kind: z.enum(['exec', 'commands', 'network', 'config-commands', 'console']),
                level: z.number().int().min(0).max(15).optional(),
                list: aaaList.optional(),
                methods: methods.optional(),
                ifAuthenticated: z.boolean().optional(),
              })
              .strict()
          )
          .max(16),
        accounting: z
          .array(
            z
              .object({
                kind: z.enum(['exec', 'commands', 'network', 'connection', 'system', 'dot1x']),
                level: z.number().int().min(0).max(15).optional(),
                list: aaaList,
                record: z.enum(['start-stop', 'stop-only', 'none']),
                methods: methods.optional(),
              })
              .strict()
          )
          .max(16),
        sessionIdCommon: z.boolean().optional(),
      })
      .strict()
      .optional(),
    aaaServers: z.array(iosAaaServerSchema).max(16).optional(),
    aaaGroups: z
      .array(
        z
          .object({
            kind: z.enum(['tacacs', 'radius']),
            name,
            servers: z.array(name).max(8),
            sourceInterface: z.string().max(64).optional(),
          })
          .strict()
      )
      .max(16)
      .optional(),
    // Global "ip tacacs source-interface" / "ip radius source-interface".
    aaaSourceInterface: z
      .object({ tacacs: z.string().max(64).optional(), radius: z.string().max(64).optional() })
      .strict()
      .optional(),
    ssh: z
      .object({
        version: z.union([z.literal(1), z.literal(2)]).optional(),
        timeout: z.number().int().min(1).max(120).optional(),
        retries: z.number().int().min(0).max(5).optional(),
        sourceInterface: z.string().max(64).optional(),
        scp: z.boolean().optional(),
      })
      .strict()
      .optional(),
    // RSA key pair generated with "crypto key generate rsa" (kept in NVRAM, not in running-config).
    rsaModulus: z.number().int().min(360).max(4096).optional(),
    lines: z.array(iosLineSchema).max(20).optional(),
    banners: z
      .object({
        motd: z.string().max(2048).optional(),
        login: z.string().max(2048).optional(),
        exec: z.string().max(2048).optional(),
      })
      .strict()
      .optional(),
    http: z
      .object({
        server: z.boolean().optional(),
        secureServer: z.boolean().optional(),
        authentication: z.enum(['local', 'enable', 'aaa']).optional(),
      })
      .strict()
      .optional(),
    logging: z
      .object({
        // IOS buffers messages by default (4096 bytes, debugging); false is "no logging buffered".
        buffered: z
          .union([
            z.object({ size: z.number().int().min(4096).max(2147483647), level }).strict(),
            z.literal(false),
          ])
          .optional(),
        console: z.union([level, z.literal(false)]).optional(),
        monitor: z.union([level, z.literal(false)]).optional(),
        // "logging trap" / "logging facility" typed before any "logging host": applied when the host is added.
        trap: level.optional(),
        facility: z.number().int().min(0).max(23).optional(),
        sourceInterface: z.string().max(64).optional(),
      })
      .strict()
      .optional(),
    snmp: z
      .object({
        location: z.string().max(255).optional(),
        contact: z.string().max(255).optional(),
        hosts: z.array(iosSnmpHostSchema).max(16).optional(),
        // "snmp-server enable traps [types...]": true for all, or the listed notification types.
        traps: z.union([z.literal(true), z.array(z.string().regex(/^[\w-]{1,32}$/)).max(32)]).optional(),
        trapSource: z.string().max(64).optional(),
        groups: z
          .array(
            z
              .object({
                name,
                security: z.enum(['noauth', 'auth', 'priv']),
                read: name.optional(),
                write: name.optional(),
                access: z
                  .string()
                  .regex(/^[\w-]{1,64}$/)
                  .optional(),
              })
              .strict()
          )
          .max(16)
          .optional(),
        // SNMPv3 users live outside running-config on IOS (private configuration).
        users: z.array(iosSnmpUserSchema).max(16).optional(),
        ifindexPersist: z.boolean().optional(),
      })
      .strict()
      .optional(),
    ntp: z
      .object({
        sourceInterface: z.string().max(64).optional(),
        prefer: ipv4Schema.optional(),
        // "ntp server X [key N] [version V] [source IF] [iburst]".
        serverOptions: z
          .array(
            z
              .object({
                address: ipv4Schema,
                key: z.number().int().min(1).max(65535).optional(),
                version: z.number().int().min(1).max(4).optional(),
                source: z.string().max(64).optional(),
                iburst: z.boolean().optional(),
              })
              .strict()
          )
          .max(8)
          .optional(),
        authenticate: z.boolean().optional(),
        keys: z
          .array(
            z.object({ id: z.number().int().min(1).max(65535), key: z.string().min(1).max(32) }).strict()
          )
          .max(16)
          .optional(),
        trustedKeys: z.array(z.number().int().min(1).max(65535)).max(16).optional(),
      })
      .strict()
      .optional(),
    errdisableRecovery: z
      .object({
        causes: z.array(z.string().regex(/^[\w-]{1,32}$/)).max(32),
        intervalS: z.number().int().min(30).max(86400),
      })
      .strict()
      .optional(),
    loginBlock: z
      .object({
        forS: z.number().int().min(1).max(65535),
        attempts: z.number().int().min(1).max(65535),
        withinS: z.number().int().min(1).max(65535),
      })
      .strict()
      .optional(),
    vtp: z
      .object({
        mode: z.enum(['server', 'client', 'transparent', 'off']),
        domain: z
          .string()
          .regex(/^[\w.-]{1,32}$/)
          .optional(),
        version: z.number().int().min(1).max(3).optional(),
        password: z.string().min(1).max(64).optional(),
      })
      .strict()
      .optional(),
    // "delete flash:vlan.dat": the switch boots with the default VLAN database.
    vlanDatDeleted: z.boolean().optional(),
    // "spanning-tree portfast default" / "spanning-tree portfast bpduguard default".
    portfastDefault: z.boolean().optional(),
    bpduguardDefault: z.boolean().optional(),
    // Global "udld enable|aggressive": UDLD on every fiber port without its own setting.
    udld: z.enum(['normal', 'aggressive']).optional(),
    // SPAN sessions ("monitor session N source|destination ...").
    monitorSessions: z
      .array(
        z
          .object({
            id: z.number().int().min(1).max(66),
            sources: z
              .array(z.object({ port: z.string().max(64), direction: z.enum(['rx', 'tx', 'both']) }).strict())
              .max(16),
            vlans: z.array(z.number().int().min(1).max(4094)).max(64).optional(),
            destination: z.string().max(64).optional(),
          })
          .strict()
      )
      .max(4)
      .optional(),
  })
  .strict();
export type IosSystem = z.infer<typeof iosSystemSchema>;
export type IosLine = z.infer<typeof iosLineSchema>;
export const iosVtpSchema = iosSystemSchema.shape.vtp.unwrap();
