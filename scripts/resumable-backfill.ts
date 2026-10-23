type BackfillState = { nextCursor: string | null; processed: number; seen: Set<string> };

export async function runResumableBackfill<T>(
  state: BackfillState,
  readPage: (cursor: string | null) => Promise<{ records: T[]; nextCursor: string | null }>,
  keyOf: (record: T) => string,
  apply: (record: T) => Promise<void>,
): Promise<BackfillState> {
  let cursor = state.nextCursor;
  do {
    const page = await readPage(cursor);
    for (const record of page.records) {
      const key = keyOf(record);
      if (state.seen.has(key)) continue;
      await apply(record);
      state.seen.add(key);
      state.processed += 1;
    }
    cursor = page.nextCursor;
    state.nextCursor = cursor;
  } while (cursor !== null);
  return state;
}
