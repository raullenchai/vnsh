/**
 * vnsh Onboarding — Step-by-step guided tutorial
 */

let currentStep = 1;

function showStep(step: number): void {
  const prev = document.getElementById(`step-${currentStep}`);
  const next = document.getElementById(`step-${step}`);
  if (prev) prev.classList.remove('active');
  if (next) next.classList.add('active');

  // Update progress dots
  document.querySelectorAll('.progress-dot').forEach((dot) => {
    const dotStep = parseInt((dot as HTMLElement).dataset.step || '0');
    dot.classList.toggle('active', dotStep <= step);
  });

  currentStep = step;
}

// "Next" buttons via data attributes
document.querySelectorAll<HTMLButtonElement>('.btn-next[data-next]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const next = parseInt(btn.dataset.next || '1');
    showStep(next);
  });
});

// Click on progress dots
document.querySelectorAll('.progress-dot').forEach((dot) => {
  dot.addEventListener('click', () => {
    const step = parseInt((dot as HTMLElement).dataset.step || '1');
    showStep(step);
  });
});
