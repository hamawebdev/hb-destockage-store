// Admin progressive enhancement (optional: every page works without it). No innerHTML.
'use strict';
document.addEventListener('submit', (e) => {
  const form = e.target;
  if (form instanceof HTMLFormElement && form.dataset.confirm && !window.confirm(form.dataset.confirm)) e.preventDefault();
});
// The navigation <details> is closed in the HTML (phones). From 768 px it is always shown:
// admin.css does it with ::details-content; this covers engines without that pseudo-element.
const nav = document.querySelector('.nav-disclosure');
const wide = window.matchMedia('(min-width: 768px)');
const sync = () => {
  if (nav && wide.matches) nav.setAttribute('open', '');
};
sync();
wide.addEventListener('change', sync);
