import { configurationPatchSchema, type ConfigurationPatch, type Snapshot } from '@shlab/engine';
export function normalizeBulkConfiguration(input: unknown, snapshot: Snapshot): ConfigurationPatch {
  if (!Array.isArray(input) || !input.length || input.length > 2000)
    throw new Error('Informe uma lista de 1 a 2000 alterações.');
  const devices = new Map(snapshot.devices.flatMap((d) => [[d.id, d] as const, [d.hostname, d] as const])),
    changes = new Map<string, ConfigurationPatch[number]>();
  for (const raw of input) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Alteração inválida.');
    let entry: ConfigurationPatch[number];
    if ('device' in raw) entry = configurationPatchSchema.parse([raw])[0];
    else {
      if (
        Object.keys(raw).some(
          (key) => !['hostname', 'port', 'ip', 'prefix', 'gateway', 'dns', 'description'].includes(key)
        )
      )
        throw new Error('Campos desconhecidos na configuração anterior.');
      const { hostname, ...port } = raw;
      entry = configurationPatchSchema.parse([{ device: hostname, ports: [port] }])[0];
    }
    const device = devices.get(entry.device);
    if (!device) throw new Error('Equipamento inexistente: ' + entry.device);
    const existing = changes.get(device.id) ?? { device: device.id };
    for (const key of ['routes', 'firewall'] as const)
      if (key in entry) {
        if (key in existing) throw new Error('Configuração repetida de ' + key + ' em ' + device.hostname);
        Object.assign(existing, { [key]: entry[key] });
      }
    for (const port of entry.ports ?? []) {
      const interfaceId = device.interfaces.find((p) => p.id === port.port || p.name === port.port)?.id;
      if (!interfaceId) throw new Error('Interface inexistente: ' + device.hostname + '/' + port.port);
      existing.ports ??= [];
      if (existing.ports.some((p) => p.port === interfaceId))
        throw new Error(
          'Interface repetida; reúna seus campos em uma alteração: ' + device.hostname + '/' + port.port
        );
      existing.ports.push({ ...port, port: interfaceId });
    }
    changes.set(device.id, existing);
  }
  return configurationPatchSchema.parse([...changes.values()]);
}
