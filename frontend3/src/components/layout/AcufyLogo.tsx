import React from 'react';

// Ported from frontend2. Single themable SVG: the sphere paths use
// var(--logo-c-mid) and the wordmark uses currentColor, so the logo recolors
// itself per theme (see themeVariants.applyThemeVariant). One asset, one
// aspect ratio across all six themes.

interface AcufyLogoProps {
  /** 'full' = sphere + wordmark. 'icon' = sphere only (clipped). */
  variant?: 'full' | 'icon';
  className?: string;
  /** Render height in px. Default 56. */
  height?: number;
}

const LOGO_URL = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/acufy-logo.svg`;

let cachedMarkup: string | null = null;
let inflight: Promise<string> | null = null;

function useLogoMarkup(): string | null {
  const [markup, setMarkup] = React.useState<string | null>(cachedMarkup);
  React.useEffect(() => {
    if (cachedMarkup) {
      if (markup !== cachedMarkup) setMarkup(cachedMarkup);
      return;
    }
    if (!inflight) {
      inflight = fetch(LOGO_URL)
        .then((r) => r.text())
        .then((text) => {
          const stripped = text
            .replace(/<\?xml[^>]*\?>/g, '')
            .replace(/<!DOCTYPE[^>]*>/g, '')
            .trim();
          cachedMarkup = stripped;
          return stripped;
        })
        .catch(() => '');
    }
    inflight.then((text) => setMarkup(text));
  }, [markup]);
  return markup;
}

export const AcufyLogo: React.FC<AcufyLogoProps> = ({
  variant = 'full',
  className,
  height = 56,
}) => {
  const markup = useLogoMarkup();

  if (variant === 'icon') {
    const iconSize = Math.round(height * 0.92);
    return (
      <span
        className={`inline-block overflow-hidden text-foreground ${className ?? ''}`}
        style={{ width: iconSize, height: iconSize }}
        aria-label="Acufy AI"
      >
        {markup ? (
          <span
            aria-hidden
            style={{
              display: 'inline-block',
              height: '100%',
              aspectRatio: '2103 / 740',
              overflow: 'hidden',
            }}
            dangerouslySetInnerHTML={{
              __html: markup.replace(
                /<svg([^>]*)>/,
                `<svg$1 style="height:100%;width:auto;display:block">`,
              ),
            }}
          />
        ) : null}
      </span>
    );
  }

  return (
    <span
      className={`inline-block text-foreground ${className ?? ''}`}
      style={{ height, lineHeight: 0 }}
      aria-label="Acufy AI"
      role="img"
    >
      {markup ? (
        <span
          aria-hidden
          style={{ display: 'inline-block', height: '100%' }}
          dangerouslySetInnerHTML={{
            __html: markup.replace(
              /<svg([^>]*)>/,
              `<svg$1 style="height:100%;width:auto;display:block">`,
            ),
          }}
        />
      ) : null}
    </span>
  );
};
