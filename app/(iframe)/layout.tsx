import { ApplyThemeScript } from '@/components/embed-iframe/theme-provider';
import { RootLayout } from '@/components/root-layout';

interface RootLayoutProps {
  children: React.ReactNode;
}

export default async function Layout({ children }: RootLayoutProps) {
  return (
    <RootLayout className="bg-transparent" headContent={<ApplyThemeScript />}>
      {children}
    </RootLayout>
  );
}
