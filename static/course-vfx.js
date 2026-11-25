// Course-only reward accents: a small kira when a checkpoint answer lands correct.
(() => {
  const seen = new WeakSet();
  const celebrate = (root) => {
    if (!root?.querySelectorAll) return;
    for (const el of root.querySelectorAll('.practice-option[data-state="correct"]')) {
      if (seen.has(el)) continue;
      seen.add(el);
      const rect = el.getBoundingClientRect();
      const x = rect.left + rect.width * 0.82, y = rect.top + rect.height * 0.45;
      window.SakugaFX?.kira(x, y, { r: 10, life: 0.55 });
      window.SakugaFX?.kira(x - 34, y + 8, { r: 6, life: 0.45 });
    }
  };
  const scan = () => celebrate(document.getElementById('panel-lesson'));
  const start = () => {
    scan();
    const host = document.getElementById('panel-lesson');
    if (!host) return;
    new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes') celebrate(mutation.target.parentElement || mutation.target);
        for (const node of mutation.addedNodes) celebrate(node);
      }
    }).observe(host, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-state'] });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
