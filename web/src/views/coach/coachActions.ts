import { createContext, useContext } from "react";

/**
 * Contexts that let interactive cards inside coach messages act on the app.
 * Two levels because react-markdown component overrides can't take props:
 *
 * - CoachActionsContext (provided by CoachShell): app-level actions a
 *   ```choices button can trigger.
 * - MessageContext (provided per bubble by CoachChatView): whether this
 *   message's interactive blocks are live (only the LAST coach message while
 *   the thread is idle — stale blocks deep in the transcript must not fire
 *   actions), plus send() for posting a button's text as the user's reply.
 */

export interface CoachActions {
  openAddSources: () => void;
  findSources: () => void;
}

export const CoachActionsContext = createContext<CoachActions>({
  openAddSources: () => {},
  findSources: () => {},
});

export interface MessageInfo {
  interactive: boolean;
  send: (text: string) => void;
}

export const MessageContext = createContext<MessageInfo>({ interactive: false, send: () => {} });

export function useCoachActions(): CoachActions {
  return useContext(CoachActionsContext);
}

export function useMessageInfo(): MessageInfo {
  return useContext(MessageContext);
}
