export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="brand" role={compact ? 'img' : undefined} aria-label={compact ? 'shLab' : undefined}>
      <span className="brand-mark" aria-hidden="true">
        <img src="/shlab-mark.svg" alt="" width="36" height="36" />
      </span>
      {!compact && (
        <span className="brand-name">
          sh<span className="brand-accent">Lab</span>
        </span>
      )}
    </div>
  );
}
