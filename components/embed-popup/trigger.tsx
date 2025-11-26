import { AnimatePresence, motion } from 'motion/react';
import { useVoiceAssistant } from '@livekit/components-react';
import { PhoneDisconnectIcon, XIcon } from '@phosphor-icons/react';
import { EmbedErrorDetails } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Button } from '../ui/button';

const AnimatedButton = motion.create(Button);

// DevPlusOps Logo SVG component
function DevPlusOpsLogo({ className, fill = 'black' }: { className?: string; fill?: string }) {
  return (
    <svg
      className={className}
      viewBox="80 50 240 120"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        fill={fill}
        d="M208.703918,152.340149 C208.641205,145.080002 208.709076,138.247986 208.557236,131.420868 C208.491669,128.472763 209.659302,126.909081 212.415314,125.872162 C241.37973,114.97464 270.307648,103.980125 299.249451,93.022415 C304.355408,91.089233 305.232452,91.617271 305.291626,96.835289 C305.361542,102.998436 305.198608,109.165756 305.355591,115.325691 C305.431152,118.291405 304.255249,119.868225 301.511566,120.885292 C275.138519,130.661636 248.793732,140.514099 222.446655,150.360306 C219.329041,151.525406 216.282791,152.892349 213.131699,153.952408 C211.566498,154.478958 209.501968,155.726807 208.703918,152.340149"
      />
      <path
        fill={fill}
        d="M134.647827,108.21019 C150.06897,114.120323 165.104141,119.965347 180.228516,125.569557 C183.193939,126.668358 184.498932,128.11084 184.429779,131.317474 C184.26561,138.931351 184.376953,146.551163 184.376953,153.815643 C182.391693,154.941391 181.195312,154.206161 179.978546,153.752029 C151.468521,143.111267 122.992661,132.377274 94.417213,121.915253 C89.908333,120.264473 88.301376,117.908478 88.569923,113.176659 C88.962807,106.254128 88.670998,99.292725 88.670998,91.087845 C104.590988,97.010628 119.442024,102.535713 134.647827,108.21019"
      />
      <path
        fill={fill}
        d="M264.454529,77.138977 C268.278992,79.431328 265.800262,80.33493 263.894104,81.031197 C257.01889,83.542496 249.723389,85.20388 243.283081,88.53344 C234.042145,93.310883 225.609619,93.068321 216.34407,88.687912 C208.881577,85.159935 208.627274,85.774208 208.594254,77.615334 C208.576096,73.123299 208.48671,68.62867 208.295151,64.140953 C208.055862,58.534676 208.911758,57.822304 214.156876,59.642181 C230.811569,65.420799 247.462479,71.210373 264.454529,77.138977"
      />
      <path
        fill={fill}
        d="M184.36908,76.928452 C184.241623,87.297997 185.338959,84.866585 176.435333,88.969635 C167.627731,93.028412 159.719391,93.370613 150.977127,88.807289 C144.856674,85.612511 137.902802,84.024147 131.348099,81.644096 C129.858505,81.103218 128.082077,80.895027 126.800179,78.239143 C145.538254,71.231964 164.204117,64.490219 184.368179,58.194244 C184.368179,64.722366 184.368179,70.581329 184.36908,76.928452"
      />
    </svg>
  );
}

interface TriggerProps {
  error: EmbedErrorDetails | null;
  popupOpen: boolean;
  onToggle: () => void;
}

export function Trigger({ error = null, popupOpen, onToggle }: TriggerProps) {
  const { state: agentState } = useVoiceAssistant();

  const isAgentConnecting =
    popupOpen && (agentState === 'connecting' || agentState === 'initializing');

  const isAgentConnected =
    popupOpen &&
    agentState !== 'disconnected' &&
    agentState !== 'connecting' &&
    agentState !== 'initializing';

  return (
    <AnimatePresence>
      <AnimatedButton
        key="trigger-button"
        size="lg"
        initial={{
          scale: 0,
        }}
        animate={{
          scale: 1,
        }}
        exit={{ scale: 0 }}
        transition={{
          type: 'spring',
          duration: 1,
          bounce: 0.2,
        }}
        onClick={onToggle}
        className={cn(
          'relative m-0 block size-12 p-0.5 drop-shadow-md',
          'scale-100 transition-[scale] duration-300 hover:scale-105 focus:scale-105',
          'fixed right-4 bottom-4 z-50'
        )}
      >
        {/* ring */}
        <motion.div
          className={cn(
            'absolute inset-0 z-10 rounded-full transition-colors',
            !popupOpen && 'bg-fgAccent',
            !error &&
              isAgentConnecting &&
              'bg-fgAccent/30 animate-spin [background-image:conic-gradient(from_0deg,transparent_0%,transparent_30%,var(--color-fgAccent)_50%,transparent_70%,transparent_100%)]',
            (isAgentConnected || (error && popupOpen)) && 'bg-destructive-foreground'
          )}
        />
        {/* icon */}
        <div
          className={cn(
            'relative z-20 grid size-11 place-items-center rounded-full transition-colors',
            !popupOpen && 'bg-fgAccent',
            !error && isAgentConnecting && 'bg-bg1',
            (isAgentConnected || (error && popupOpen)) && 'bg-destructive'
          )}
        >
          <AnimatePresence>
            {!popupOpen && (
              <motion.div
                key="lk-logo"
                initial={{ opacity: 0, y: -20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: popupOpen ? 20 : -20 }}
                className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2"
              >
                <DevPlusOpsLogo className="size-5" fill="var(--color-bg1)" />
              </motion.div>
            )}
            {(isAgentConnecting || (error && popupOpen)) && (
              <motion.div
                key="dismiss"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: popupOpen ? -20 : 20 }}
                className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2"
              >
                <XIcon
                  size={20}
                  weight="bold"
                  className={cn('text-fg0 size-5', error && 'text-destructive-foreground')}
                />
              </motion.div>
            )}
            {!error && isAgentConnected && (
              <motion.div
                key="disconnect"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: popupOpen ? -20 : 20 }}
                className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2"
              >
                <PhoneDisconnectIcon
                  size={20}
                  weight="bold"
                  className="text-destructive-foreground size-5"
                />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </AnimatedButton>
    </AnimatePresence>
  );
}
