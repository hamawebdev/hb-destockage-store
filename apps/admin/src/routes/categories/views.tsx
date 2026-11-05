// Category pages (ACAT-1). Server-rendered with admin-core's UI kit; no JS, no inline style.
import type { Category } from '@hb/db';
import { categoryPath } from '@hb/catalog';
import { useUi } from '../../ui/context.ts';
import { StatusBadge } from '../../ui/badge.tsx';
import { Bdi, Num } from '../../ui/format.tsx';
import {
  Checkbox,
  ErrorSummary,
  Form,
  FormActions,
  LocalizedField,
  NumberInput,
  Select,
  Submit,
  TextInput,
  type FieldErrors,
  type FormValues,
} from '../../ui/form.tsx';
import { Table, type Column } from '../../ui/table.tsx';
import { fieldMessages } from '../products/lib/field-messages.ts';
import { m } from './messages.ts';
import type { Ordered } from './tree.ts';
import { DESCRIPTION_MAX, NAME_MAX } from './validate.ts';

const indent = (depth: number): string => '— '.repeat(depth);
const nameIn = (c: Category, lang: 'fr' | 'ar'): string => (lang === 'ar' ? c.nameAr : c.nameFr);

function Badges(props: { c: Category }) {
  const { lang } = useUi();
  const tm = m(lang);
  const tf = fieldMessages(lang);
  return (
    <>
      {props.c.active ? <StatusBadge tone="success" label={tm('status.active')} /> : <StatusBadge tone="neutral" label={tm('status.archived')} />}
      {props.c.placeholder ? <> <StatusBadge tone="warning" label={tf('common.placeholder')} /></> : null}
    </>
  );
}

export interface ListRow {
  ordered: Ordered<Category>;
  products: number;
}

export function CategoryList(props: { rows: readonly ListRow[] }) {
  const { lang } = useUi();
  const tm = m(lang);
  const other = lang === 'ar' ? 'fr' : 'ar';
  const columns: Column<ListRow>[] = [
    {
      key: 'name',
      header: tm('col.name'),
      cell: (r) => (
        <>
          <span aria-hidden="true">{indent(r.ordered.depth)}</span>
          <a href={`/categories/${r.ordered.node.id}`}>{nameIn(r.ordered.node, lang)}</a>
          <br />
          <span lang={other} dir={other === 'ar' ? 'rtl' : 'ltr'}>{nameIn(r.ordered.node, other)}</span>
        </>
      ),
    },
    {
      key: 'slugs',
      header: tm('col.slugs'),
      cell: (r) => (
        <>
          <Bdi ltr>{r.ordered.node.slugFr}</Bdi> / <Bdi ltr>{r.ordered.node.slugAr}</Bdi>
        </>
      ),
    },
    { key: 'products', header: tm('col.products'), numeric: true, cell: (r) => <Num value={r.products} /> },
    { key: 'status', header: tm('col.status'), cell: (r) => <Badges c={r.ordered.node} /> },
    { key: 'sort', header: tm('col.sort'), numeric: true, cell: (r) => <Num value={r.ordered.node.sort} /> },
  ];
  return <Table caption={tm('caption')} columns={columns} rows={props.rows} rowKey={(r) => r.ordered.node.id} empty={tm('empty')} />;
}

export interface FormProps {
  action: string;
  values: FormValues;
  errors?: FieldErrors | undefined;
  parents: readonly Ordered<Category>[];
  /** Shown when an active category's slug is about to change: the URLs that will stop working. */
  slugWarning?: readonly string[] | undefined;
}

export function CategoryForm(props: FormProps) {
  const { lang, t } = useUi();
  const tm = m(lang);
  const tf = fieldMessages(lang);
  const labels: Record<string, string> = {
    name_fr: `${tm('field.name')} (${t('common.fr')})`,
    name_ar: `${tm('field.name')} (${t('common.ar')})`,
    description_fr: `${tm('field.description')} (${t('common.fr')})`,
    description_ar: `${tm('field.description')} (${t('common.ar')})`,
    slug_fr: tm('field.slugFr'),
    slug_ar: tm('field.slugAr'),
    parent_id: tm('field.parent'),
    sort: tm('field.sort'),
  };
  const checked = (name: string): boolean => props.values[name] !== undefined && props.values[name] !== '';
  return (
    <Form action={props.action}>
      <ErrorSummary errors={props.errors} labels={labels} />
      {props.slugWarning ? (
        <div class="callout callout--warning" role="alert">
          <h2>{tm('slugChange.title')}</h2>
          <p>{tm('slugChange.body')}</p>
          <ul>
            {props.slugWarning.map((u) => (
              <li><Bdi ltr>{u}</Bdi></li>
            ))}
          </ul>
          <Checkbox name="confirm_slug_change" label={tm('slugChange.confirm')} />
        </div>
      ) : null}
      {props.values['v'] !== undefined ? <input type="hidden" name="v" value={props.values['v']} /> : null}
      <LocalizedField name="name" label={tm('field.name')} values={props.values} errors={props.errors} maxlength={NAME_MAX} required />
      <LocalizedField name="description" label={tm('field.description')} values={props.values} errors={props.errors} maxlength={DESCRIPTION_MAX} multiline />
      <TextInput name="slug_fr" label={tm('field.slugFr')} hint={tf('common.slugHint')} value={props.values['slug_fr']} error={props.errors?.['slug_fr']} dir="ltr" lang="fr" maxlength={80} />
      <TextInput name="slug_ar" label={tm('field.slugAr')} hint={tf('common.slugHint')} value={props.values['slug_ar']} error={props.errors?.['slug_ar']} dir="ltr" maxlength={80} />
      <Select
        name="parent_id"
        label={tm('field.parent')}
        value={props.values['parent_id']}
        error={props.errors?.['parent_id']}
        placeholder={tm('field.parentNone')}
        options={props.parents.map((p) => ({ value: String(p.node.id), label: indent(p.depth) + nameIn(p.node, lang) }))}
      />
      <NumberInput name="sort" label={tm('field.sort')} hint={tm('field.sortHint')} value={props.values['sort']} error={props.errors?.['sort']} />
      <Checkbox name="active" label={tm('field.active')} checked={checked('active')} />
      <Checkbox name="placeholder" label={tf('common.placeholder')} hint={tf('common.placeholderHint')} checked={checked('placeholder')} />
      <Checkbox name="tp_fr" label={tf('common.translationPlaceholderFr')} checked={checked('tp_fr')} />
      <Checkbox name="tp_ar" label={tf('common.translationPlaceholderAr')} checked={checked('tp_ar')} />
      <FormActions>
        <Submit>{t('common.save')}</Submit>
        <a class="btn btn--secondary" href="/categories">{t('common.cancel')}</a>
      </FormActions>
    </Form>
  );
}

/** Archive/restore and delete actions shown under the edit form. */
export function CategoryActions(props: { category: Category; activeProductsHidden: number; parentArchived: boolean }) {
  const { lang, t } = useUi();
  const tm = m(lang);
  const id = props.category.id;
  return (
    <section class="panel" aria-labelledby="cat-actions">
      <h2 id="cat-actions">{t('common.actions')}</h2>
      {props.category.active ? (
        <Form action={`/categories/${id}/archive`} confirm={tm('archive.confirm')}>
          <p>{tm('archive.effect', { count: props.activeProductsHidden })}</p>
          <Submit variant="secondary">{tm('archive')}</Submit>
        </Form>
      ) : (
        <Form action={`/categories/${id}/restore`}>
          {props.parentArchived ? <p>{tm('restore.parentHidden')}</p> : null}
          <Submit variant="secondary">{tm('restore')}</Submit>
        </Form>
      )}
      <p>
        <a class="btn btn--danger" href={`/categories/${id}/delete`}>{tm('delete')}</a>
      </p>
    </section>
  );
}

/** For roles that can read the catalogue but not edit it (confirmer, logistics). */
export function CategoryReadonly(props: { category: Category; parentName: string | null }) {
  const { lang, t } = useUi();
  const tm = m(lang);
  const c = props.category;
  return (
    <>
      <p class="callout">{tm('readonly')}</p>
      <dl class="details">
        <dt>{tm('field.name')} ({t('common.fr')})</dt>
        <dd lang="fr" dir="ltr">{c.nameFr}</dd>
        <dt>{tm('field.name')} ({t('common.ar')})</dt>
        <dd lang="ar" dir="rtl">{c.nameAr}</dd>
        <dt>{tm('col.slugs')}</dt>
        <dd>
          <Bdi ltr>{c.slugFr}</Bdi> / <Bdi ltr>{c.slugAr}</Bdi>
        </dd>
        <dt>{tm('field.parent')}</dt>
        <dd>{props.parentName ?? tm('field.parentNone')}</dd>
        <dt>{tm('col.status')}</dt>
        <dd><Badges c={c} /></dd>
      </dl>
    </>
  );
}

export function DeletePage(props: { category: Category; products: number; children: number }) {
  const { lang, t } = useUi();
  const tm = m(lang);
  const c = props.category;
  const blocked = props.products > 0 || props.children > 0;
  return (
    <>
      <p>
        <strong>{nameIn(c, lang)}</strong> (<Bdi ltr>{c.slugFr}</Bdi>)
      </p>
      {blocked ? (
        <p class="callout callout--warning" role="alert">
          {tm('delete.blocked', { products: props.products, children: props.children })}
        </p>
      ) : (
        <Form action={`/categories/${c.id}/delete`}>
          <p>{tm('delete.confirm')}</p>
          <FormActions>
            <Submit variant="danger">{tm('delete')}</Submit>
            <a class="btn btn--secondary" href={`/categories/${c.id}`}>{t('common.cancel')}</a>
          </FormActions>
        </Form>
      )}
    </>
  );
}

/** URLs of an active category that stop working when its slugs change. */
export function brokenUrls(before: Category, after: { slugFr: string; slugAr: string }): string[] {
  const out: string[] = [];
  if (before.slugFr !== after.slugFr) out.push(categoryPath('fr', before.slugFr));
  if (before.slugAr !== after.slugAr) out.push(categoryPath('ar', before.slugAr));
  return out;
}
