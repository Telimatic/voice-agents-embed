import { PhoneIcon } from '@phosphor-icons/react';
import { Button } from '@/components/ui/button';

type WelcomeViewProps = {
  disabled: boolean;
  onStartCall: () => void;
};

export const WelcomeView = ({
  disabled,
  onStartCall,
  ref,
}: React.ComponentProps<'div'> & WelcomeViewProps) => {
  return (
    <div ref={ref} inert={disabled} className="absolute inset-0">
      <div className="flex h-full items-center justify-between gap-4 px-3">
        <div className="bg-primary flex size-8 items-center justify-center rounded-full pl-0">
          <PhoneIcon size={18} weight="fill" className="text-primary-foreground" />
        </div>

        <Button variant="primary" size="lg" onClick={onStartCall} className="w-48 font-mono">
          Chat with Agent
        </Button>
      </div>
    </div>
  );
};
