// STUDY SAKUGA — small empty-state enhancer owned by the study worker.
(() => {
  const actions = new Map([
    ['completed-activities', ['Chọn bài đầu tiên ↗', '#curriculum']],
    ['weak-spots-list', ['Mở lộ trình ↗', '#curriculum']],
    ['bookmarked-items-list', ['Học một chủ đề ↗', '#curriculum']],
  ]);
  const emptyish = el => el && !el.querySelector('article,.bookmarked-item,.completed-row') && el.textContent.trim().length > 3;
  function decorate() {
    for (const [id, [label, href]] of actions) {
      const el = document.getElementById(id);
      if (!emptyish(el)) { el.classList.remove("study-empty-box"); continue; }
      el.classList.add("study-empty-box");
      if (!el.querySelector('.study-empty-action')) {
        const a = document.createElement('a');
        a.className = 'study-empty-action';
        a.href = href;
        a.textContent = label;
        el.append(a);
      }
    }
  }
  const start = () => {
    decorate();
    for (const id of actions.keys()) {
      const el = document.getElementById(id);
      if (el) new MutationObserver(decorate).observe(el, { childList: true, subtree: true, characterData: true });
    }
  };
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', start) : start();
})();
