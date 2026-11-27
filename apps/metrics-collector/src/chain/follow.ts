// Owns the reads of Gyblos channels after their open: (4) each followed channel's own signature list,
// its later successful transactions read in full, oldest first, at most CHAIN_INDEX.maxReadsPerChannelPoll
// per poll; and (5) channel accounts. Half of each run's polls go to channels never polled, half to the
// least recently polled, each at most every CHAIN_INDEX.followIntervalMs, so new opens (anyone can open
// one with a Gyblos memo) never starve known channels. A list that fills a whole page in one poll is a
// flood (only an attack produces it): the channel is no longer listed, but its account state is still
// read with the other Gyblos channels'.
import { and, asc, eq, isNotNull, isNull, lte, ne, or } from 'drizzle-orm';

import { CHAIN_CHANNEL_CLOSED, CHAIN_INDEX } from '../constants';
import { chainChannels } from '../schema';
import { channelState } from './channel-account';
import type { ChainTransaction } from './decode';
import { readTransaction, type ChainRun } from './run';
import { channelStateUpserts, followUpdate, transactionWrites } from './writes';

const followed = {
  channel: chainChannels.channel,
  until: chainChannels.followUntil,
};

async function dueChannels(run: ChainRun) {
  const half = Math.ceil(CHAIN_INDEX.maxFollowedPerRun / 2);
  const due = lte(
    chainChannels.followedAt,
    run.now - CHAIN_INDEX.followIntervalMs,
  );
  const [fresh, known] = await run.orm.batch([
    run.orm
      .select(followed)
      .from(chainChannels)
      .where(
        and(eq(chainChannels.following, 1), isNull(chainChannels.followedAt)),
      )
      .limit(half),
    run.orm
      .select(followed)
      .from(chainChannels)
      .where(
        and(
          eq(chainChannels.following, 1),
          isNotNull(chainChannels.followedAt),
          due,
        ),
      )
      .orderBy(asc(chainChannels.followedAt))
      .limit(half),
  ]);
  // Known channels first: they never wait behind a burst of new opens.
  return [...known, ...fresh];
}

export async function followChannels(run: ChainRun) {
  for (const { channel, until } of await dueChannels(run)) {
    if (run.rpc.remaining() <= 0) break;
    await followChannel(run, channel, until);
  }
  return run.followed;
}

async function followChannel(
  run: ChainRun,
  channel: string,
  until: string | null,
) {
  const page = await run.rpc.signatures(channel, until ? { until } : {});
  run.followed += 1;
  if (page.length >= CHAIN_INDEX.signaturesPerPage) {
    run.flooded += 1;
    await run.orm.batch([
      followUpdate(
        run.orm,
        channel,
        { until, following: false },
        run.now,
        run.lease,
      ),
    ]);
    return;
  }
  const read: ChainTransaction[] = [];
  let newest = until;
  let failure: unknown;
  try {
    for (const entry of [...page].reverse()) {
      if (!entry.failed) {
        if (
          read.length >= CHAIN_INDEX.maxReadsPerChannelPoll ||
          run.rpc.remaining() <= 0
        )
          break;
        read.push(await readTransaction(run, entry.signature));
      }
      newest = entry.signature;
    }
  } catch (error) {
    failure = error;
  }
  await run.orm.batch([
    followUpdate(
      run.orm,
      channel,
      { until: newest, following: true },
      run.now,
      run.lease,
    ),
    ...transactionWrites(run.orm, read, run.now),
  ]);
  if (failure) throw failure;
}

// (5) Accounts of the channels this run touched, of channels never read, and of every Gyblos channel
// not closed whose state is older than the follow interval (one call per hundred).
export async function refreshChannels(run: ChainRun) {
  const stale = await run.orm
    .select({ channel: chainChannels.channel })
    .from(chainChannels)
    .where(
      or(
        isNull(chainChannels.accountReadAt),
        and(
          eq(chainChannels.gyblos, 1),
          or(
            isNull(chainChannels.status),
            ne(chainChannels.status, CHAIN_CHANNEL_CLOSED),
          ),
          lte(
            chainChannels.accountReadAt,
            run.now - CHAIN_INDEX.followIntervalMs,
          ),
        ),
      ),
    )
    .orderBy(asc(chainChannels.accountReadAt))
    .limit(CHAIN_INDEX.accountsPerRequest);
  for (const { channel } of stale) run.touched.add(channel);
  const channels = [...run.touched];
  let read = 0;
  for (
    let start = 0;
    start < channels.length && run.rpc.remaining() > 0;
    start += CHAIN_INDEX.accountsPerRequest
  ) {
    const batch = channels.slice(start, start + CHAIN_INDEX.accountsPerRequest);
    const accounts = await run.rpc.accounts(batch);
    const [first, ...rest] = channelStateUpserts(
      run.orm,
      batch.map((channel, index) => ({
        channel,
        state: channelState(accounts[index] ?? null),
      })),
      run.now,
    );
    if (first) await run.orm.batch([first, ...rest]);
    read += batch.length;
  }
  return read;
}
