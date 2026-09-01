import { useConfigStore } from '@/store/configStore';
import { Spinner } from '@/components/ui';

// Full-screen boot loader. Migrated to the Tailwind design system.
const LoadingScreen: React.FC = () => {
  const { brandConfig } = useConfigStore();

  return (
    <div className="flex min-h-screen items-center justify-center bg-app">
      <div className="text-center text-primary-500">
        <Spinner size="lg" />
        <p className="mt-3 text-ink-soft">Loading {brandConfig.productName}...</p>
      </div>
    </div>
  );
};

export default LoadingScreen;
