import { BsQuestionCircle } from 'react-icons/bs';
import { useHelpStore } from '@/store/helpStore';
import type { HelpArticle } from '@/types/help';

interface HelpIconProps {
  article: HelpArticle;
}

const HelpIcon: React.FC<HelpIconProps> = ({ article }) => {
  const openHelp = useHelpStore((s) => s.openHelp);

  return (
    <BsQuestionCircle
      size={13}
      className="text-ink-soft ms-1"
      style={{ cursor: 'pointer', opacity: 0.6, transition: 'opacity 0.15s' }}
      onMouseEnter={(e) => { (e.target as HTMLElement).style.opacity = '1'; }}
      onMouseLeave={(e) => { (e.target as HTMLElement).style.opacity = '0.6'; }}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openHelp(article);
      }}
    />
  );
};

export default HelpIcon;
