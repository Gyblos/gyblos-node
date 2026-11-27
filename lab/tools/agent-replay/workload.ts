import { FREE_CHAT_ROLES } from '@gyblos/protocol/constants';

import { replayRequest, type ReplayMessage, type ReplayTiming } from './client';
import { AGENT_REPLAY, REPLAY_ROLES, type ReplayRole } from './constants';

const SYSTEMS: Record<ReplayRole, string> = {
  [REPLAY_ROLES.TITLE]: AGENT_REPLAY.prompts.title,
  [REPLAY_ROLES.SUMMARY]: AGENT_REPLAY.prompts.summary,
  [REPLAY_ROLES.MAIN]: AGENT_REPLAY.prompts.main,
};

function padding(turn: number) {
  return ` context-${turn}`.repeat(
    Math.ceil(AGENT_REPLAY.turnChars / ` context-${turn}`.length),
  );
}

export async function replayAgentSession(
  url: string,
  origin: number,
  signal: AbortSignal,
) {
  const timings: ReplayTiming[] = [];
  let sequence = 0;
  const history: ReplayMessage[] = [
    { role: FREE_CHAT_ROLES.USER, content: AGENT_REPLAY.prompts.task },
  ];
  const send = (role: ReplayRole, turn: number) => {
    const tag = `${AGENT_REPLAY.tagPrefix}${++sequence}`;
    const messages: ReplayMessage[] = [
      { role: FREE_CHAT_ROLES.SYSTEM, content: SYSTEMS[role] },
      ...history,
      { role: FREE_CHAT_ROLES.USER, content: tag },
    ];
    return replayRequest(url, { tag, role, turn, messages }, origin, signal);
  };
  const opening = await Promise.all([
    send(REPLAY_ROLES.TITLE, 0),
    send(REPLAY_ROLES.SUMMARY, 0),
    send(REPLAY_ROLES.MAIN, 0),
  ]);
  timings.push(...opening);
  for (let turn = 1; turn <= AGENT_REPLAY.loopTurns; turn++) {
    const previous = timings.at(-1)!;
    history.push(
      {
        role: FREE_CHAT_ROLES.ASSISTANT,
        content: previous.text || AGENT_REPLAY.prompts.call,
      },
      {
        role: FREE_CHAT_ROLES.USER,
        content: `${AGENT_REPLAY.prompts.tool}${padding(turn)}`,
      },
    );
    timings.push(await send(REPLAY_ROLES.MAIN, turn));
  }
  return timings;
}
