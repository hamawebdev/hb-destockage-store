// /media (ACAT-3): product and category photos. Owner: admin-catalog. Plan: artifacts/ACAT-0/plan.md §6.
//
// GET  /                 recent uploads (media.edit)
// POST /upload           multipart: owner=product:<id>|category:<id>, files (1–10), alt_fr, alt_ar, placeholder
// GET  /:id/original     the original from R2 (catalog.view): stored type, inline; admin-core adds
//                        nosniff, CSP sandbox and private no-store to every non-HTML response
// POST /:id              alt fr/ar, binding (whole product / option value / variant), placeholder
// POST /:id/move         dir=up|down
// GET  /:id/delete, POST delete (R2 object removed when no other row references its key)
//
// Type and size come from the bytes (sniff.ts), never from the filename or Content-Type. The R2
// key is generated here. Request bodies are capped by admin-core's limit (10 MiB on /media/upload).
import type { Context } from 'hono';
import * as v from 'valibot';
import { noAudit } from '../../audit/audit.ts';
import { requirePerm } from '../../auth/require-role.ts';
import { rolesFor } from '../../auth/permissions.ts';
import type { AppEnv } from '../../env.ts';
import { paramId, parseForm, validateForm, vCheckbox, vPicklist, vText } from '../../lib/forms.ts';
import { createRouter } from '../../lib/router.ts';
import { ErrorSummary } from '../../ui/form.tsx';
import { withFlash } from '../../ui/flash.tsx';
import { fieldMessages } from '../products/lib/field-messages.ts';
import { cleanText } from '../products/lib/text.ts';
import {
  bindChoices,
  deleteImage,
  loadImage,
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_PIXELS,
  MAX_SIDE_PX,
  MIN_LONG_SIDE,
  moveImage,
  ownerOf,
  ownerPath,
  recentImages,
  resolveOwner,
  updateImage,
  uploadImages,
  validBinding,
  type Upload,
} from './data.ts';
import { m } from './messages.ts';
import { checkStructure, EXT, MIME, sniffImage, type ImageType } from './sniff.ts';
import { DeletePage, RecentList } from './views.tsx';

type Ctx = Context<AppEnv>;

// Floor = catalogue readers (originals are shown on read-only pages); every route narrows further.
const r = createRouter({ roles: rolesFor('catalog.view') });

const UploadFields = v.strictObject({
  owner: v.optional(v.string(), ''),
  alt_fr: vText(200),
  alt_ar: vText(200),
  placeholder: vCheckbox(),
});
const EditFields = v.strictObject({ alt_fr: vText(200), alt_ar: vText(200), bind: v.optional(v.string(), ''), placeholder: vCheckbox() });
const MoveFields = v.strictObject({ dir: vPicklist(['up', 'down'] as const) });
const EmptyForm = v.strictObject({});

/** Error page for media POSTs: the errors and a way back to the product/category. */
function failPage(c: Ctx, status: 404 | 409 | 413 | 415 | 422, back: string, errors: Record<string, string>) {
  c.status(status);
  const tm = m(c.var.lang);
  return c.render(
    <>
      <ErrorSummary errors={errors} />
      <p>
        <a class="btn btn--secondary" href={back}>{c.var.t('common.cancel')}</a>
      </p>
    </>,
    { title: tm('title') },
  );
}

function alts(c: Ctx, fr: string, ar: string): { ok: true; fr: string; ar: string } | { ok: false; errors: Record<string, string> } {
  const a = cleanText(fr);
  const b = cleanText(ar);
  const tf = fieldMessages(c.var.lang);
  const errors: Record<string, string> = {};
  if (!a.ok) errors['alt_fr'] = tf('err.unsafe_char');
  if (!b.ok) errors['alt_ar'] = tf('err.unsafe_char');
  return a.ok && b.ok ? { ok: true, fr: a.value, ar: b.value } : { ok: false, errors };
}

// ---------------------------------------------------------------------------------------------

r.get('/', requirePerm('media.edit'), async (c) => {
  const tm = m(c.var.lang);
  return c.render(
    <>
      <h2>{tm('recent')}</h2>
      <RecentList images={await recentImages(c)} />
    </>,
    { title: tm('title') },
  );
});

r.post('/upload', requirePerm('media.edit'), async (c) => {
  const tm = m(c.var.lang);
  const body = await c.req.parseBody({ all: true });
  const strings: Record<string, string> = {};
  const files: File[] = [];
  for (const [k, val] of Object.entries(body)) {
    if (k === '_csrf') continue;
    for (const item of Array.isArray(val) ? val : [val]) {
      if (k === 'files' && item instanceof File) {
        if (item.size > 0 || item.name !== '') files.push(item);
      } else if (typeof item === 'string') strings[k] = item;
      else return failPage(c, 422, '/media', { _form: c.var.t('form.invalid') }); // a file in a text field
    }
  }
  const owner = await resolveOwner(c, strings['owner']);
  const back = owner === null ? '/media' : `${ownerPath(owner)}#sec-photos`;
  if (owner === null) return failPage(c, 404, back, { owner: tm('err.owner') });
  const f = validateForm(c, UploadFields, strings);
  if (!f.ok) return failPage(c, 422, back, f.errors);
  const alt = alts(c, f.data.alt_fr, f.data.alt_ar);
  if (!alt.ok) return failPage(c, 422, back, alt.errors);
  if (files.length === 0) return failPage(c, 422, back, { files: tm('err.none') });
  if (files.length > MAX_FILES) return failPage(c, 413, back, { files: tm('err.too_many') });

  const uploads: Upload[] = [];
  const errors: Record<string, string> = {};
  for (const [i, file] of files.entries()) {
    const name = file.name.slice(0, 80) || `#${i + 1}`;
    if (file.size > MAX_FILE_BYTES) {
      errors[`files_${i}`] = tm('err.too_large', { name });
      continue;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const s = sniffImage(bytes);
    if (!s.ok) {
      errors[`files_${i}`] = tm(`err.${s.error}`, { name });
      continue;
    }
    if (!checkStructure(bytes, s.type)) errors[`files_${i}`] = tm('err.truncated', { name });
    else if (Math.max(s.width, s.height) < MIN_LONG_SIDE) errors[`files_${i}`] = tm('err.too_small', { name });
    else if (Math.max(s.width, s.height) > MAX_SIDE_PX) errors[`files_${i}`] = tm('err.too_wide', { name });
    else if (s.width * s.height > MAX_PIXELS) errors[`files_${i}`] = tm('err.too_many_pixels', { name });
    else uploads.push({ bytes, type: s.type, width: s.width, height: s.height, name });
  }
  // All or nothing: one bad file refuses the whole upload, so nothing is half-added.
  if (Object.keys(errors).length > 0) {
    const tooLarge = files.some((file) => file.size > MAX_FILE_BYTES);
    return failPage(c, tooLarge ? 413 : 415, back, errors);
  }
  await uploadImages(c, owner, uploads, { fr: alt.fr, ar: alt.ar }, f.data.placeholder === true);
  return c.redirect(`${withFlash(ownerPath(owner), 'created')}#sec-photos`, 303);
});

r.get('/:id/original', requirePerm('catalog.view'), async (c) => {
  const id = paramId(c);
  const img = id === null ? undefined : await loadImage(c, id);
  if (img === undefined) return c.notFound();
  const obj = await c.env.MEDIA.get(img.r2Key);
  if (obj === null) return c.notFound();
  const type = obj.httpMetadata?.contentType ?? 'application/octet-stream';
  const known = (Object.keys(MIME) as ImageType[]).find((k) => MIME[k] === type);
  const ext = known === undefined ? undefined : EXT[known];
  return new Response(obj.body, {
    headers: {
      // Only the four sniffed types are ever stored; anything else (e.g. a seed object without
      // metadata) is served as a download, never rendered inline.
      'Content-Type': ext ? type : 'application/octet-stream',
      'Content-Disposition': `${ext ? 'inline' : 'attachment'}; filename="${img.id}.${ext ?? 'bin'}"`,
    },
  });
});

r.post('/:id', requirePerm('media.edit'), async (c) => {
  const id = paramId(c);
  const img = id === null ? undefined : await loadImage(c, id);
  if (img === undefined) return c.notFound();
  const owner = ownerOf(img);
  const back = `${ownerPath(owner)}#sec-photos`;
  const f = await parseForm(c, EditFields);
  if (!f.ok) return failPage(c, 422, back, f.errors);
  const alt = alts(c, f.data.alt_fr, f.data.alt_ar);
  if (!alt.ok) return failPage(c, 422, back, alt.errors);
  let binding: { variantId: number | null; optionValueId: number | null } | null = { variantId: null, optionValueId: null };
  if (owner.kind === 'product') binding = validBinding(await bindChoices(c, owner.id), f.data.bind);
  else if (f.data.bind !== '') binding = null; // category images cannot be bound
  if (binding === null) return failPage(c, 422, back, { bind: m(c.var.lang)('err.bind') });
  const changed = await updateImage(c, img, { altFr: alt.fr, altAr: alt.ar, ...binding, placeholder: f.data.placeholder === true });
  if (!changed) {
    noAudit(c, 'image form submitted without changes: nothing written');
  }
  return c.redirect(`${withFlash(ownerPath(owner), 'saved')}#sec-photos`, 303);
});

r.post('/:id/move', requirePerm('media.edit'), async (c) => {
  const id = paramId(c);
  const img = id === null ? undefined : await loadImage(c, id);
  if (img === undefined) return c.notFound();
  const owner = ownerOf(img);
  const f = await parseForm(c, MoveFields);
  if (!f.ok) return failPage(c, 422, `${ownerPath(owner)}#sec-photos`, f.errors);
  if (!(await moveImage(c, img, f.data.dir))) {
    noAudit(c, 'already first/last: nothing moved');
  }
  return c.redirect(`${ownerPath(owner)}#sec-photos`, 303);
});

r.get('/:id/delete', requirePerm('media.edit'), async (c) => {
  const id = paramId(c);
  const img = id === null ? undefined : await loadImage(c, id);
  if (img === undefined) return c.notFound();
  return c.render(<DeletePage img={img} back={`${ownerPath(ownerOf(img))}#sec-photos`} />, { title: m(c.var.lang)('delete.title') });
});

r.post('/:id/delete', requirePerm('media.edit'), async (c) => {
  const id = paramId(c);
  const img = id === null ? undefined : await loadImage(c, id);
  if (img === undefined) return c.notFound();
  const f = await parseForm(c, EmptyForm);
  if (!f.ok) return c.text('Bad Request', 400);
  await deleteImage(c, img);
  return c.redirect(`${withFlash(ownerPath(ownerOf(img)), 'deleted')}#sec-photos`, 303);
});

export default r;
