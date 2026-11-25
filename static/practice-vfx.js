(() => {
  const meta = {
    flashcards: { kana: 'カ', copy: 'Lật · nhớ · lặp lại' },
    kanji: { kana: '漢', copy: 'Nhìn nét · nhớ chữ' },
    kaiwa: { kana: '話', copy: 'Nghe · nói · sửa' },
    quiz: { kana: '試', copy: 'Đếm giờ · chọn đáp án' }
  };
  const panels = Object.keys(meta).map((name) => document.getElementById(`panel-${name}`)).filter(Boolean);
  if (!panels.length) return;

  function decorateHub(panel) {
    const feature = panel.id.replace('panel-', '');
    const hub = panel.querySelector('.skill-hub');
    if (!hub || !hub.querySelector('.level-course-card')) return;
    hub.dataset.practiceHub = feature;
    const heading = hub.querySelector('.workspace-heading');
    if (heading && !heading.querySelector('.practice-hub-copy')) {
      const copy = document.createElement('span');
      copy.className = 'practice-hub-copy';
      copy.textContent = meta[feature].copy;
      heading.querySelector('h1')?.after(copy);
      const kana = document.createElement('span');
      kana.className = 'practice-hub-kana';
      kana.lang = 'ja';
      kana.setAttribute('aria-hidden', 'true');
      kana.textContent = meta[feature].kana;
      heading.append(kana);
      const mascot = document.createElement('img');
      mascot.className = 'practice-hub-mascot';
      mascot.src = 'assets/lam/pixel/display/south.png';
      mascot.alt = '';
      mascot.width = 44;
      mascot.height = 80;
      heading.append(mascot);
    }
    hub.querySelectorAll('.level-course-card').forEach((card, index) => {
      card.style.setProperty('--stagger', `${Math.min(index, 4) * 45}ms`);
      card.dataset.level = card.querySelector('.level-cover')?.dataset.level || '';
    });
  }

  const quizTypes = {
    choice: 'Chọn đáp án', reading: 'Đọc hiểu', listening: 'Nghe', grammar: 'Ngữ pháp',
    vocab: 'Từ vựng', vocabulary: 'Từ vựng', kanji: 'Hán tự', recall: 'Nhớ lại', writing: 'Tự viết'
  };
  function localizeQuizType() {
    const node = document.getElementById('quiz-q-type');
    if (!node) return;
    const key = node.textContent.trim().toLowerCase();
    if (quizTypes[key]) node.textContent = quizTypes[key];
  }
  function scan() { for (const panel of panels) decorateHub(panel); localizeQuizType(); }
  scan();
  new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
  document.addEventListener('error', (event) => {
    const img = event.target;
    if (!(img instanceof HTMLImageElement) || !img.src.includes('assets/lam/pixel/display/idle/')) return;
    img.src = img.src.replace('assets/lam/pixel/display/idle/', 'assets/lam/pixel/idle/');
  }, true);

  document.addEventListener('click', (event) => {
    const option = event.target.closest?.('.quiz-option-btn');
    if (!option || !document.getElementById('panel-quiz')?.contains(option)) return;
    setTimeout(() => {
      const fx = window.SakugaFX;
      if (!fx) return;
      const state = option.dataset.state;
      if (state !== 'correct' && state !== 'incorrect') return;
      const c = fx.at(option);
      if (state === 'correct') {
        fx.kira(c.x - c.w * 0.32, c.y - c.h * 0.2, { r: 9, life: 0.55 });
        fx.kira(c.x + c.w * 0.28, c.y + c.h * 0.12, { r: 7, life: 0.48 });
      } else {
        fx.slash(c.x, c.y, { len: 74, ang: -0.42, life: 0.32, thick: 9 });
      }
    }, 30);
  });
})();
