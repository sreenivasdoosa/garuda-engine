import { GarudaBird } from './GarudaMark';

interface BrandLogoProps {
  /** `full` is the bird beside the wordmark; `small` is the bird alone. */
  variant?: 'full' | 'small';
  className?: string;
  height?: number;
}

/**
 * The lockup: bird, name, and the word ENGINE set small beside it.
 *
 * Both parts are inline SVG and DOM text rather than one image file, so the
 * name takes `currentColor` from whatever it sits on — white on the sign-in
 * page, the theme's ink in the console — and stays selectable and legible when
 * a browser scales text up.
 */
const BrandLogo: React.FC<BrandLogoProps> = ({
  variant = 'full',
  className = '',
  height = 36,
}) => {
  if (variant === 'small') {
    return <GarudaBird height={height} className={className} title="Garuda Engine" />;
  }

  return (
    <span className={`inline-flex items-center gap-3 ${className}`}>
      <GarudaBird height={height} title="Garuda Engine" />
      <span className="flex items-baseline gap-2">
        <span
          className="font-display font-bold leading-none tracking-tight"
          style={{ fontSize: height * 0.72 }}
        >
          Garuda
        </span>
        <span
          className="font-semibold uppercase leading-none opacity-55"
          style={{ fontSize: height * 0.3, letterSpacing: '0.22em' }}
        >
          Engine
        </span>
      </span>
    </span>
  );
};

export default BrandLogo;
