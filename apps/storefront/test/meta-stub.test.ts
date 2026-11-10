// The stub, public/js/meta.js: what it does before any input, including inside a prerender (META-5; Addendum 7).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = () => void;

function setup(init: { stored: string | null; prerendering?: boolean; tpl?: string; consent?: string }) {
  const docListeners = new Map<string, Listener>();
  const winListeners = new Map<string, Listener>();
  const state = { stored: init.stored };
  const getItem = vi.fn(() => state.stored);
  const removeItem = vi.fn();
  const doc = {
    prerendering: init.prerendering ?? false,
    body: { dataset: { metaPixel: '000000000000000', metaConsent: init.consent ?? 'required' } },
    documentElement: { dataset: { tpl: init.tpl ?? 'home' } },
    querySelector: () => null,
    addEventListener: (e: string, f: Listener) => void docListeners.set(e, f),
  };
  vi.stubGlobal('document', doc);
  vi.stubGlobal('localStorage', { getItem });
  vi.stubGlobal('sessionStorage', { removeItem });
  vi.stubGlobal('addEventListener', (e: string, f: Listener) => void winListeners.set(e, f));
  vi.stubGlobal('removeEventListener', (e: string) => void winListeners.delete(e));
  return { doc, docListeners, winListeners, getItem, state };
}

const boot = vi.fn(async () => {});

beforeEach(() => {
  boot.mockClear();
  vi.resetModules();
  vi.doMock('../public/js/meta-full.js', () => ({ boot, reset: vi.fn() }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock('../public/js/meta-full.js');
});

const loadStub = () => import('../public/js/meta.js');
const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 1));
};
function activate(x: ReturnType<typeof setup>) {
  x.doc.prerendering = false;
  x.docListeners.get('prerenderingchange')!();
}

describe('before any input', () => {
  it('no choice: arms the first-input listeners and loads nothing', async () => {
    const x = setup({ stored: null });
    await loadStub();
    await flush();
    expect(boot).not.toHaveBeenCalled();
    expect([...x.winListeners.keys()].sort()).toEqual(['keydown', 'pointerdown', 'scroll']);
  });
  it('stored decline: nothing is armed or loaded', async () => {
    const x = setup({ stored: 'denied' });
    await loadStub();
    await flush();
    expect(boot).not.toHaveBeenCalled();
    expect(x.winListeners.size).toBe(0);
  });
  it('stored accept: starts the full code', async () => {
    setup({ stored: 'granted' });
    await loadStub();
    await flush();
    expect(boot).toHaveBeenCalledWith('000000000000000', 'start');
  });
  it('the order step offers no choice', async () => {
    const x = setup({ stored: null, tpl: 'order-step' });
    await loadStub();
    await flush();
    expect(x.winListeners.size).toBe(0);
  });
});

describe('inside a prerender', () => {
  it('reads nothing and arms nothing until the page is shown', async () => {
    const x = setup({ stored: null, prerendering: true });
    await loadStub();
    await flush();
    expect(x.getItem).not.toHaveBeenCalled();
    expect(x.winListeners.size).toBe(0);
    expect(boot).not.toHaveBeenCalled();
  });
  it('an accept stored during the prerender starts the full code on activation', async () => {
    const x = setup({ stored: null, prerendering: true });
    await loadStub();
    x.state.stored = 'granted';
    activate(x);
    await flush();
    expect(boot).toHaveBeenCalledWith('000000000000000', 'start');
    expect(x.winListeners.size).toBe(0);
  });
  it('a decline stored during the prerender stays silent on activation', async () => {
    const x = setup({ stored: null, prerendering: true });
    await loadStub();
    x.state.stored = 'denied';
    activate(x);
    await flush();
    expect(boot).not.toHaveBeenCalled();
    expect(x.winListeners.size).toBe(0);
  });
});
