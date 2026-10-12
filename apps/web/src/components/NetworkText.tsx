import { memo } from 'react';
import { ipv4Schema, ipv6Schema } from '@shlab/engine';

/** Keep the original explanation intact while making valid network addresses easier to scan. */
export const NetworkText = memo(function NetworkText({ text }: { text: string }) {
  const parts = text.split(/((?:\d{1,3}\.){3}\d{1,3}|[\da-fA-F:.]*:[\da-fA-F:.]+)/g);
  return parts.map((part, index) =>
    index % 2 === 1 && (ipv4Schema.safeParse(part).success || ipv6Schema.safeParse(part).success) ? (
      <span className="network-address" key={index}>
        {part}
      </span>
    ) : (
      part
    )
  );
});
