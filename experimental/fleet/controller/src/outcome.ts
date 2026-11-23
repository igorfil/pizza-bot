export type Outcome<T> = { ok: true; value: T } | { ok: false; error: string };

export const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The boundary with libraries that throw: everything past it sees an Outcome. */
export const attempt = async <T>(f: () => Promise<T> | T): Promise<Outcome<T>> => {
  try {
    return { ok: true, value: await f() };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
};

export const ok = <T>(value: T): Outcome<T> => ({ ok: true, value });

export const fail = <T = never>(error: string): Outcome<T> => ({ ok: false, error });
