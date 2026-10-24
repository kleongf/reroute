// @ts-nocheck
// PROTOTYPE (throwaway): floating variant/scene switcher. Only mounted when ?variant= is present.

export function mountSwitcher({ variants, scenes, read, onChange }) {
  const keys = Object.keys(variants);
  const pill = document.createElement('div');
  pill.className = 'proto-switcher';
  pill.innerHTML = `
    <button type="button" data-dir="-1" aria-label="Previous variant">←</button>
    <span class="lbl"></span>
    <button type="button" data-dir="1" aria-label="Next variant">→</button>
    <select aria-label="Scene">${scenes.map((s) => `<option value="${s}">${s}</option>`).join('')}</select>`;
  document.body.append(pill);
  const lbl = pill.querySelector('.lbl');
  const sel = pill.querySelector('select');

  const set = (patch) => {
    const q = new URLSearchParams(location.search);
    for (const [k, v] of Object.entries(patch)) q.set(k, v);
    history.replaceState(null, '', `${location.pathname}?${q}`);
    sync();
    onChange();
  };
  const sync = () => {
    const { variant, scene } = read();
    lbl.textContent = `${variant} (${variants[variant]})`;
    sel.value = scene;
  };
  const cycle = (dir) => {
    const i = keys.indexOf(read().variant);
    set({ variant: keys[(i + dir + keys.length) % keys.length] });
  };

  pill.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => cycle(Number(b.dataset.dir))));
  sel.addEventListener('change', () => set({ scene: sel.value }));
  window.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t instanceof HTMLElement && (t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]') || t.isContentEditable)) return;
    if (e.key === 'ArrowLeft') cycle(-1);
    if (e.key === 'ArrowRight') cycle(1);
  });
  sync();
}
