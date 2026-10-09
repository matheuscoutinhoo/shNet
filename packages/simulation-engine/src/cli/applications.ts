import { ALL_MODES, CONFIG_MODES, type CommandRegistry } from './registry';
export function registerApplicationCommands(r: CommandRegistry) {
  r.register({
    pattern: /^eap (server|authenticator|supplicant) configure (.+)$/i,
    modes: CONFIG_MODES,
    run: (m, e, d) => {
      const c = JSON.parse(m[2]);
      if (m[1].toLowerCase() === 'server') e.configureEapServer(d.id, c);
      else if (m[1].toLowerCase() === 'authenticator') e.configureEapAuthenticator(d.id, c);
      else e.configureEapSupplicant(d.id, c);
    },
  });
  r.register({
    pattern: /^show eap$/i,
    modes: ALL_MODES,
    run: (_m, _e, d) =>
      JSON.stringify(
        { server: d.eapServer, supplicant: d.eapSupplicant, authenticator: d.eapAuthenticator },
        null,
        2
      ),
  });

  r.register({
    pattern: /^(wlc|wtp|mesh|ids) configure (.+)$/i,
    modes: CONFIG_MODES,
    run: (m, e, d) => {
      const c = JSON.parse(m[2]);
      switch (m[1].toLowerCase()) {
        case 'wlc':
          e.configureWlc(d.id, c);
          break;
        case 'wtp':
          e.configureWtp(d.id, c);
          break;
        case 'mesh':
          e.configureMesh(d.id, c);
          break;
        case 'ids':
          e.configureIds(d.id, c);
      }
    },
  });
  r.register({
    pattern: /^show (wlc|wtp|mesh|ids)$/i,
    modes: ALL_MODES,
    run: (m, _e, d) => JSON.stringify(d[m[1].toLowerCase() as 'wlc' | 'wtp' | 'mesh' | 'ids'] ?? {}, null, 2),
  });
  r.register({
    pattern: /^poe configure (.+)$/i,
    modes: CONFIG_MODES,
    run: (m, e, d) => {
      const c = JSON.parse(m[1]);
      e.configurePoe(d.id, c.supply, c.load);
    },
  });
  r.register({
    pattern: /^hardware add (serial|console)(?: (.+))?$/i,
    modes: CONFIG_MODES,
    run: (m, e, d) => {
      e.addHardwarePort(
        d.id,
        m[1].toLowerCase() as 'serial' | 'console',
        m[2] ? JSON.parse(m[2]) : undefined
      );
    },
  });
  r.register({
    pattern: /^console ([\w-]+) (.+)$/i,
    modes: ALL_MODES,
    run: (m, e, d) => e.consoleCommand(d.id, m[1], m[2]),
  });
  r.register({
    pattern: /^(phone|proxy|printer|broker) configure (.+)$/i,
    modes: CONFIG_MODES,
    run: (m, e, d) => {
      const c = JSON.parse(m[2]);
      switch (m[1].toLowerCase()) {
        case 'phone':
          e.configurePhone(d.id, c);
          break;
        case 'proxy':
          e.configureProxy(d.id, c);
          break;
        case 'printer':
          e.configurePrinter(d.id, c);
          break;
        case 'broker':
          e.configureBroker(d.id, c);
      }
    },
  });
  r.register({
    pattern: /^phone call ([\d.]+)(?: (\d+))?$/i,
    modes: ALL_MODES,
    run: (m, e, d) => e.callPhone(d.id, m[1], Number(m[2] ?? 5060)),
  });
  r.register({
    pattern: /^phone hangup ([\w-]+)$/i,
    modes: ALL_MODES,
    run: (m, e, d) => e.hangupPhone(d.id, m[1]),
  });
  r.register({
    pattern: /^print ([a-f\d.:]+) (\d+) (.+)$/i,
    modes: ALL_MODES,
    run: (m, e, d) => e.submitPrint(d.id, m[1], m[3], Number(m[2])),
  });
  r.register({
    pattern: /^mqtt connect ([a-f\d.:]+)(?: ([\w-]+))?$/i,
    modes: ALL_MODES,
    run: (m, e, d) => e.connectIot(d.id, m[1], m[2]),
  });
  r.register({
    pattern: /^mqtt subscribe (\S+)$/i,
    modes: ALL_MODES,
    run: (m, e, d) => e.subscribeIot(d.id, m[1]),
  });
  r.register({
    pattern: /^mqtt publish (\S+) (.+)$/i,
    modes: ALL_MODES,
    run: (m, e, d) => e.publishIot(d.id, m[1], m[2]),
  });
  r.register({
    pattern: /^show (phone|proxy|printer|broker|iot)$/i,
    modes: ALL_MODES,
    run: (m, _e, d) =>
      JSON.stringify(
        d[m[1].toLowerCase() as 'phone' | 'proxy' | 'printer' | 'broker' | 'iot'] ?? {},
        null,
        2
      ),
  });
}
