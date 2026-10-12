import { configurationSchemas, radioObstructions, type Device } from '@shlab/engine';

/** Guard the authoring UI; imported engine snapshots retain their existing physical conditions. */
export function wlcPhysicalControls(input: unknown, previous: Device['wlc']) {
  const config = configurationSchemas.advancedNetwork.wlc.parse(input);
  for (const [index, profile] of config.profiles.entries()) {
    const existing =
      previous?.profiles.find((entry) => entry.name === profile.name) ?? previous?.profiles[index];
    if (profile.wireless.noise !== (existing?.wireless.noise ?? -95))
      throw new Error('O ruído ambiente é uma condição do cenário e não pode ser definido neste formulário.');
    if (
      !radioObstructions.some((entry) => entry.attenuation === profile.wireless.attenuation) &&
      profile.wireless.attenuation !== existing?.wireless.attenuation
    )
      throw new Error('Escolha uma obstrução do rádio; não defina uma atenuação numérica.');
  }
  return config;
}
