import type { Device } from '../model';

/** A Cisco IP phone: the factory phone hardware profile or a device running the SIP phone application. */
export const ipPhone = (d: Device) => d.profile === 'phone' || !!d.phone;
