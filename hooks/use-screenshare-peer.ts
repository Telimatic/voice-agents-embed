'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ParticipantKind, RoomEvent } from 'livekit-client';
import { useRoomContext } from '@livekit/components-react';
import {
  ATTR_ENABLED,
  type NotifyPayload,
  RPC_NOTIFY,
  SCREENSHARE_PROTOCOL_VERSION,
  type StopReason,
} from '@/lib/screenshare-protocol';

/**
 * TLZ-561. The agent side of the screenshare conversation, as seen from the widget:
 * whether there is an agent that can receive a share, where to reach it, and how to tell
 * it that a share has ended.
 *
 * It is deliberately separate from `useScreenshareSession`, which owns the caller's own
 * state. The session hook reports a stop exactly once, from its single
 * `LocalTrackUnpublished` listener; this is what turns that one report into one
 * `screenshare.notify`.
 */

/** Bounded: the notification is best-effort and must never hold anything up. */
const NOTIFY_RESPONSE_TIMEOUT_MS = 5_000;

/**
 * A structural view of a participant. The real type is livekit-client's
 * `RemoteParticipant`; only these four fields are ever read, and reading them
 * structurally is what lets the tests drive the real room events with plain objects.
 */
export type AgentParticipantLike = {
  identity?: string;
  kind?: unknown;
  isAgent?: boolean;
  attributes?: Record<string, string>;
};

/** The worker joins as an agent-kind participant. */
export function isAgentParticipant(participant: AgentParticipantLike | undefined): boolean {
  if (!participant) {
    return false;
  }
  return participant.isAgent === true || participant.kind === ParticipantKind.AGENT;
}

/**
 * An agent that is not merely present but is listening for a share. Without this second
 * condition the caller could start a share nobody receives, which publishes a screen
 * track against no consent record at all.
 */
export function agentCanReceiveShare(participant: AgentParticipantLike | undefined): boolean {
  return isAgentParticipant(participant) && participant?.attributes?.[ATTR_ENABLED] === 'true';
}

export interface ScreenshareAgentState {
  /** True only while an agent that can receive a share is in the room. */
  agentReady: boolean;
  /**
   * Where a notification is sent. This is the LAST agent seen rather than the current
   * one, because the share that most needs reporting is the one the agent's own
   * departure ended -- and by then it is no longer in `remoteParticipants`.
   */
  agentIdentity: string | null;
}

/**
 * Watches the room for an agent that can receive a share.
 *
 * `ParticipantAttributesChanged` matters as much as `ParticipantConnected` here: the
 * agent publishes `telzino.screenshare.enabled` AFTER it joins, so a connect-only
 * listener would show the control to nobody, or never show it at all.
 */
export function useScreenshareAgent(): ScreenshareAgentState {
  const room = useRoomContext();
  const [state, setState] = useState<ScreenshareAgentState>({
    agentReady: false,
    agentIdentity: null,
  });

  useEffect(() => {
    if (!room) {
      return;
    }
    const evaluate = () => {
      const participants = room.remoteParticipants
        ? Array.from(room.remoteParticipants.values())
        : [];
      const ready = participants.find((participant) =>
        agentCanReceiveShare(participant as AgentParticipantLike)
      );
      const present =
        ready ??
        participants.find((participant) => isAgentParticipant(participant as AgentParticipantLike));
      setState((previous) => {
        const agentReady = Boolean(ready);
        // A departed agent leaves its identity behind on purpose; see `agentIdentity`.
        const agentIdentity = present?.identity ?? previous.agentIdentity;
        if (previous.agentReady === agentReady && previous.agentIdentity === agentIdentity) {
          return previous;
        }
        return { agentReady, agentIdentity };
      });
    };

    evaluate();
    room.on(RoomEvent.Connected, evaluate);
    room.on(RoomEvent.ParticipantConnected, evaluate);
    room.on(RoomEvent.ParticipantDisconnected, evaluate);
    room.on(RoomEvent.ParticipantAttributesChanged, evaluate);
    return () => {
      room.off(RoomEvent.Connected, evaluate);
      room.off(RoomEvent.ParticipantConnected, evaluate);
      room.off(RoomEvent.ParticipantDisconnected, evaluate);
      room.off(RoomEvent.ParticipantAttributesChanged, evaluate);
    };
  }, [room]);

  return state;
}

/**
 * Who ended the share. This is the attribution the track events cannot express: an
 * unpublish looks identical whoever caused it, and the audit row needs to say which.
 */
const STOP_INITIATOR: Record<StopReason, NotifyPayload['initiated_by']> = {
  caller_stop: 'caller',
  browser_stop: 'caller',
  agent_end: 'agent',
  agent_left: 'agent',
};

export function stopNotifyPayload(reason: StopReason): NotifyPayload {
  return {
    v: SCREENSHARE_PROTOCOL_VERSION,
    event: 'stopped',
    // A reason added to the protocol later is attributed to the caller rather than
    // silently to the agent: the caller is the party a wrong attribution wrongs.
    initiated_by: STOP_INITIATOR[reason] ?? 'caller',
    reason,
  };
}

/**
 * The `onStopped` handler for `useScreenshareSession`: one ended share, one
 * `screenshare.notify`.
 *
 * Fire-and-forget by design. Nothing in this feature may end or degrade the audio
 * session, and the two cases where the RPC cannot succeed -- the agent has left, or the
 * agent has no handler registered -- are both cases where there is nothing to do about
 * it but say so in the console.
 */
export function useScreenshareStopNotifier(): (reason: StopReason) => void {
  const room = useRoomContext();
  const { agentIdentity } = useScreenshareAgent();
  const identityRef = useRef<string | null>(agentIdentity);

  useEffect(() => {
    identityRef.current = agentIdentity;
  }, [agentIdentity]);

  return useCallback(
    (reason: StopReason) => {
      const destinationIdentity = identityRef.current;
      if (!room || !destinationIdentity) {
        console.warn('[screenshare] no agent to notify that sharing stopped', reason);
        return;
      }
      const payload = stopNotifyPayload(reason);
      void (async () => {
        try {
          await room.localParticipant.performRpc({
            destinationIdentity,
            method: RPC_NOTIFY,
            payload: JSON.stringify(payload),
            responseTimeout: NOTIFY_RESPONSE_TIMEOUT_MS,
          });
        } catch (err) {
          console.warn('[screenshare] could not tell the agent that sharing stopped', err);
        }
      })();
    },
    [room]
  );
}

export default useScreenshareAgent;
