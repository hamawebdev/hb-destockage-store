// Admin progressive enhancement (optional: every page works without it). No innerHTML.
'use strict';
document.documentElement.classList.add('js');

// Confirm dialog for data-confirm forms, double-submit guard and busy state on the clicked button.
const dialog = document.getElementById('confirm-dialog');
const ask = (form, submitter) => {
  if (!(dialog instanceof HTMLDialogElement)) {
    if (window.confirm(form.dataset.confirm)) {
      form.dataset.confirmed = '1';
      form.requestSubmit(submitter ?? undefined);
    }
    return;
  }
  dialog.querySelector('#confirm-text').textContent = form.dataset.confirm;
  dialog.returnValue = '';
  dialog.addEventListener(
    'close',
    () => {
      if (dialog.returnValue === 'ok') {
        form.dataset.confirmed = '1';
        form.requestSubmit(submitter ?? undefined);
      }
    },
    { once: true },
  );
  dialog.showModal();
};

const clearBusy = () => {
  document.querySelectorAll('[data-busy]').forEach((f) => delete f.dataset.busy);
  document.querySelectorAll('.is-busy').forEach((b) => {
    b.classList.remove('is-busy');
    b.removeAttribute('aria-busy');
  });
};
window.addEventListener('pageshow', clearBusy);

document.addEventListener('submit', (e) => {
  const form = e.target;
  if (!(form instanceof HTMLFormElement) || form.getAttribute('method') === 'dialog') return;
  const submitter = e.submitter;
  if (form.dataset.confirm && !form.dataset.confirmed) {
    e.preventDefault();
    ask(form, submitter);
    return;
  }
  delete form.dataset.confirmed;
  const target = submitter?.getAttribute('formtarget') ?? form.getAttribute('target');
  if (target === '_blank') return; // printing opens a new tab: this page stays usable
  if (form.dataset.busy) {
    e.preventDefault();
    return;
  }
  form.dataset.busy = '1';
  if (submitter) {
    submitter.classList.add('is-busy');
    submitter.setAttribute('aria-busy', 'true');
  }
});

// Tick-all checkbox of a bulk table: the rows are the .pick boxes of the same form.
document.addEventListener('change', (e) => {
  const box = e.target;
  if (!(box instanceof HTMLInputElement)) return;
  const form = box.form;
  if (!form) return;
  if (box.matches('[data-pick-all]')) {
    form.querySelectorAll('.pick').forEach((p) => {
      p.checked = box.checked;
    });
  } else if (box.matches('.pick')) {
    const all = form.querySelector('[data-pick-all]');
    if (all) all.checked = [...form.querySelectorAll('.pick')].every((p) => p.checked);
  }
});

// Filter chips: one open at a time, closed by a click outside or Escape.
const chips = () => document.querySelectorAll('details.chip[open]');
document.addEventListener('toggle', (e) => {
  if (e.target instanceof HTMLDetailsElement && e.target.matches('.chip') && e.target.open) {
    chips().forEach((d) => {
      if (d !== e.target) d.open = false;
    });
  }
}, true);
document.addEventListener('click', (e) => {
  if (e.target instanceof Element && e.target.closest('details.chip')) return;
  chips().forEach((d) => {
    d.open = false;
  });
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  chips().forEach((d) => {
    d.open = false;
    d.querySelector('summary')?.focus();
  });
});

// Older browsers without the popover attribute: the menu buttons toggle the drawer by class.
if (!('popover' in HTMLElement.prototype)) {
  const side = document.getElementById('side');
  document.querySelectorAll('[popovertarget="side"]').forEach((b) => {
    b.addEventListener('click', () => side?.classList.toggle('is-open'));
  });
}
