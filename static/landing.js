(() => {
  const panel = document.getElementById('panel-landing');
  if (!panel) return;
  const demo = panel.querySelector('.public-demo');
  const answers = [...panel.querySelectorAll('[data-demo-answer]')];
  if (!demo || !answers.length) return;
  for (const button of answers) {
    button.addEventListener('click', () => {
      const fx = window.SakugaFX;
      const correct = button.dataset.demoAnswer === 'wa';
      demo.dataset.answerState = correct ? 'correct' : 'wrong';
      if (!fx) return;
      const c = fx.at(button);
      if (correct) {
        fx.burst(c.x, c.y, { r: 54, spikes: 13, life: 0.36 });
        fx.ring(c.x, c.y, { rx: 34, ry: 16, life: 0.45 });
        fx.sfx('pon', c.x + 42, c.y - 52, { size: 74, rot: -0.09, life: 0.55, ...fx.hollow() });
      } else {
        fx.slash(c.x, c.y, { len: 82, ang: -0.42, life: 0.34, thick: 11 });
        fx.lines(c.x, c.y, { n: 5, dir: 0, len: 30, spread: 18, life: 0.3 });
        demo.classList.remove('is-wrong');
        void demo.offsetWidth;
        demo.classList.add('is-wrong');
      }
    });
  }
})();
