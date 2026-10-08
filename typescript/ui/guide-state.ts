/** A managed view re-reads backend state when its own Guide changes setup. */
export function watchGuideState(window_: Window, refresh: () => Promise<void>, failure: (error: unknown) => void): () => void {
  if (new URL(window_.location.href).searchParams.get('managed') !== '1' || !window_.opener) return () => {};
  const opener = window_.opener as Window;
  const changed = (event: MessageEvent) => {
    if (event.origin !== window_.location.origin || event.source !== opener || event.data?.type !== 'harness-state-changed') return;
    void refresh().catch(failure);
  };
  window_.addEventListener('message', changed);
  return () => window_.removeEventListener('message', changed);
}
