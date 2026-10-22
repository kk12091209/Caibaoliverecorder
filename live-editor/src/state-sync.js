// One state transport per window. Explicit actions can refresh immediately;
// routine REST polling is only a fallback for absent/stale event messages.
export function stateSync({read, apply, connected, detail = () => {},
  events = () => new EventSource('/api/events'), now = Date.now,
  every = setInterval, cancel = clearInterval, pollMs = 2500, staleMs = 6000}) {
  let source, timer, pending, controller, disposed = false, started = false;
  let revision = 0, lastMessage = -Infinity, openedAt = 0, failed = true;
  function healthy() { return !failed && now() - lastMessage < staleMs; }
  function connect() {
    source?.close();
    openedAt = now();
    try { source = events(); } catch { source = null; return; }
    const current = source;
    current.onmessage = event => {
      if (disposed || source !== current) return;
      try {
        const value = JSON.parse(event.data);
        apply(value); revision++; lastMessage = now(); failed = false; connected(true);
      } catch { failed = true; connected(false); }
    };
    current.onerror = () => { if (!disposed && source === current) { failed = true; connected(false); } };
  }
  function refresh() {
    if (disposed) return Promise.resolve();
    if (pending) return pending;
    const before = revision;
    controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]);
    pending = Promise.resolve().then(() => read(signal)).then(value => {
      if (disposed || before !== revision) return;
      apply(value); connected(true);
    }).catch(() => { if (!disposed && before === revision && !healthy()) connected(false); })
      .finally(() => { pending = null; controller = null; });
    return pending;
  }
  function tick() {
    if (disposed) return;
    if (!healthy()) {
      void refresh();
      // Native EventSource retries ordinary disconnects. Recreate a silent or
      // permanently closed stream so a half-open connection cannot last forever.
      if (!source || source.readyState === 2 || now() - Math.max(openedAt,lastMessage) >= staleMs) connect();
    }
    void detail();
  }
  return {
    refresh,
    start() { if (started || disposed) return; started = true; connect(); void refresh(); timer = every(tick,pollMs); },
    close() { disposed = true; cancel(timer); source?.close(); controller?.abort(); },
  };
}
