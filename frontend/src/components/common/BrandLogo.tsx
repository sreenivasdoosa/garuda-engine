import { useTheme } from '@/context/ThemeContext';

interface BrandLogoProps {
  variant?: 'full' | 'small';
  className?: string;
  height?: number;
}

const BrandLogo: React.FC<BrandLogoProps> = ({
  variant = 'full',
  className = '',
  height = 36,
}) => {
  const { brandConfig } = useTheme();

  const logoSrc = variant === 'full' ? brandConfig.logo : brandConfig.logoSmall;

  // Fallback to text if logo fails to load
  const handleError = (e: React.SyntheticEvent<HTMLImageElement>) => {
    e.currentTarget.style.display = 'none';
    const textFallback = e.currentTarget.nextElementSibling;
    if (textFallback) {
      (textFallback as HTMLElement).style.display = 'block';
    }
  };

  return (
    <div className={`brand-logo-container ${className}`}>
      <img
        src={logoSrc}
        alt={brandConfig.displayName}
        height={height}
        className="brand-logo-image"
        onError={handleError}
        style={{ filter: 'var(--logo-filter, none)' }}
      />
      <span
        className="brand-logo-text font-bold"
        style={{
          display: 'none',
          fontSize: height * 0.5,
          color: 'var(--brand-primary)',
        }}
      >
        {variant === 'full' ? brandConfig.displayName : brandConfig.displayName.charAt(0)}
      </span>
    </div>
  );
};

export default BrandLogo;
