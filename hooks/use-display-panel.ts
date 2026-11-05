'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { type Room, RoomEvent, type RpcInvocationData } from 'livekit-client';
import { isAgentParticipant } from '@/hooks/use-screenshare-peer';
import {
  type DisplayHighlightPayload,
  type DisplayNotifyEvent,
  type DisplayPushPayload,
  RPC_DISPLAY_CLEAR,
  RPC_DISPLAY_HIGHLIGHT,
  RPC_DISPLAY_NOTIFY,
  RPC_DISPLAY_PUSH,
  SCREENSHARE_PROTOCOL_VERSION as V,
  isDisplayClearPayload,
  isDisplayHighlightPayload,
  isDisplayPushPayload,
} from '@/lib/screenshare-protocol';

/**
 * TLZ-561 (C1-C4). Receives the agent's display RPCs and holds what the panel shows.
 * Rendering is plain React state, so nothing here can block the voice path; every failure
 * becomes a reply or a warning.
 */

export type PanelMode = 'open' | 'minimized' | 'closed';
export type PanelHighlight = Pick<DisplayHighlightPayload, 'step' | 'region'>;

interface State {
  item: DisplayPushPayload | null;
  highlight: PanelHighlight | null;
  mode: PanelMode;
  /**
   * Survives close/minimize so "Reopen last" works until disconnect. Never a payment card
   * (a dismissed or paid one must not be payable again) and dropped by display.clear.
   */
  last: DisplayPushPayload | null;
}

const EMPTY: State = { item: null, highlight: null, mode: 'closed', last: null };
const NOTIFY_TIMEOUT_MS = 5000;
const reply = (body: Record<string, unknown>) => JSON.stringify({ v: V, ...body });
const BAD = () => reply({ ok: false, error: 'bad_payload' });

function parse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function useDisplayPanel(room: Room | undefined) {
  const [state, setState] = useState<State>(EMPTY);
  const ref = useRef<State>(EMPTY);
  const agentRef = useRef<string | undefined>(undefined);

  const update = useCallback((next: State) => {
    ref.current = next;
    setState(next);
  }, []);

  const notify = useCallback(
    (event: DisplayNotifyEvent, id: string) => {
      const dest = agentRef.current;
      if (!room || !dest) return;
      room.localParticipant
        .performRpc({
          destinationIdentity: dest,
          method: RPC_DISPLAY_NOTIFY,
          payload: JSON.stringify({ v: V, event, id }),
          responseTimeout: NOTIFY_TIMEOUT_MS,
        })
        .catch((err: unknown) => console.warn('[display] notify failed', err));
    },
    [room]
  );

  useEffect(() => {
    if (!room) return;

    // Only the AI agent may drive the panel; a rep or any other participant is refused.
    const fromAgent = (data: RpcInvocationData) =>
      isAgentParticipant(room.remoteParticipants.get(data.callerIdentity));

    const onPush = async (data: RpcInvocationData) => {
      if (!fromAgent(data)) return BAD();
      const payload = parse(data.payload);
      if (!isDisplayPushPayload(payload)) return BAD();
      agentRef.current = data.callerIdentity;
      // A new push replaces the content and drops any highlight.
      update({
        item: payload,
        highlight: null,
        mode: 'open',
        last: payload.kind === 'payment' ? null : payload,
      });
      return reply({ ok: true });
    };

    const onHighlight = async (data: RpcInvocationData) => {
      if (!fromAgent(data)) return BAD();
      const payload = parse(data.payload);
      if (!isDisplayHighlightPayload(payload)) return BAD();
      const { item } = ref.current;
      const fits =
        item?.id === payload.id &&
        (payload.step !== undefined
          ? item.kind === 'steps' && payload.step < (item.steps?.length ?? 0)
          : item.kind === 'image');
      if (!fits) return reply({ ok: false });
      update({ ...ref.current, highlight: { step: payload.step, region: payload.region } });
      return reply({ ok: true });
    };

    const onClear = async (data: RpcInvocationData) => {
      if (!fromAgent(data)) return BAD();
      if (!isDisplayClearPayload(parse(data.payload))) return BAD();
      update({ item: null, highlight: null, mode: 'closed', last: null });
      return reply({ ok: true });
    };

    const methods: Array<[string, (d: RpcInvocationData) => Promise<string>]> = [
      [RPC_DISPLAY_PUSH, onPush],
      [RPC_DISPLAY_HIGHLIGHT, onHighlight],
      [RPC_DISPLAY_CLEAR, onClear],
    ];
    for (const [method, handler] of methods) {
      try {
        // Re-registration after a hot reload throws; that must not take the widget down.
        room.unregisterRpcMethod(method);
        room.registerRpcMethod(method, handler);
      } catch (err) {
        console.warn(`[display] could not register ${method}`, err);
      }
    }
    const onDisconnected = () => {
      agentRef.current = undefined;
      update(EMPTY);
    };
    room.on(RoomEvent.Disconnected, onDisconnected);

    return () => {
      room.off(RoomEvent.Disconnected, onDisconnected);
      for (const [method] of methods) {
        try {
          room.unregisterRpcMethod(method);
        } catch (err) {
          console.warn('[display] could not unregister', err);
        }
      }
    };
  }, [room, update]);

  const close = useCallback(() => {
    const { item } = ref.current;
    if (!item) return;
    update({ ...ref.current, item: null, highlight: null, mode: 'closed' });
    notify('dismissed', item.id);
  }, [notify, update]);

  const minimize = useCallback(() => {
    const { item } = ref.current;
    if (!item) return;
    update({ ...ref.current, mode: 'minimized' });
    notify('minimized', item.id);
  }, [notify, update]);

  const reopen = useCallback(() => {
    const { last, item } = ref.current;
    const target = item ?? last;
    if (!target) return;
    update({ ...ref.current, item: target, mode: 'open' });
    notify('reopened', target.id);
  }, [notify, update]);

  const paymentOpened = useCallback(() => {
    const { item } = ref.current;
    if (item) notify('payment_opened', item.id);
  }, [notify]);

  return { ...state, close, minimize, reopen, paymentOpened };
}
