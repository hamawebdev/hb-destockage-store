// Admin progressive enhancement (optional: every page works without it). No innerHTML.
'use strict';
document.addEventListener('submit', (e) => {
  const form = e.target;
  if (form instanceof HTMLFormElement && form.dataset.confirm && !window.confirm(form.dataset.confirm)) e.preventDefault();
});
// Mobile: start with the navigation collapsed (it is open in the HTML for no-JS users).
if (window.matchMedia('(max-width: 767px)').matches) {
  const d = document.querySelector('.nav-disclosure');
  if (d) d.removeAttribute('open');
}
