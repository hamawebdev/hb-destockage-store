// /publish (BOOT-41, D-028): the owner or a content editor brings the storefront up to date by starting the
// pipeline's `publish` mode on GitHub (export production D1 → build the static site → deploy hb-web).
// The page also shows the pipeline's latest runs on main. Mounted at /publish in app.ts.
//
// GET  /   explanation, button, latest runs (publish.run)
// POST /   start a publication, unless one is already waiting to start (publish.run; audited)
import type { Context } from 'hono';
import * as v from 'valibot';
import { noAudit, withAudit } from '../../audit/audit.ts';
import { rolesFor } from '../../auth/permissions.ts';
import { requirePerm } from '../../auth/require-role.ts';
import type { AppEnv } from '../../env.ts';
import { parseForm } from '../../lib/forms.ts';
import { createRouter } from '../../lib/router.ts';
import { StatusBadge, type Tone } from '../../ui/badge.tsx';
import { useUi } from '../../ui/context.ts';
import { Form, FormActions, Submit } from '../../ui/form.tsx';
import { DateTime } from '../../ui/format.tsx';
import { Card } from '../../ui/kit.tsx';
import { Table } from '../../ui/table.tsx';
import { dispatchPublish, listRuns, PUBLISH_REF, PUBLISH_WORKFLOW, publishToken, type GithubError, type PipelineRun, type RunState } from './github.ts';
import { pm } from './messages.ts';

type Ctx = Context<AppEnv>;

const r = createRouter({ roles: rolesFor('publish.run') });

const TONE: Record<RunState, Tone> = { waiting: 'info', running: 'info', succeeded: 'success', failed: 'danger', cancelled: 'neutral' };

type Notice = { tone: 'success' | 'warning' | 'danger'; key: 'requested' | 'already' | 'off' | `err.${GithubError}` };

function PublishPage(props: { configured: boolean; runs: PipelineRun[] | null; notice?: Notice | undefined }) {
  const { lang } = useUi();
  const t = pm(lang);
  const runs = props.runs ?? [];
  const busy = runs.some((x) => x.state === 'running');
  const lastDone = runs.find((x) => x.state === 'succeeded' || x.state === 'failed' || x.state === 'cancelled');
  const notice = props.notice ?? (props.configured ? undefined : { tone: 'warning', key: 'off' });
  return (
    <>
      {notice ? (
        <div class={`callout callout--${notice.tone}`} role={notice.tone === 'success' ? 'status' : 'alert'} data-publish-notice={notice.key}>
          <p>{t(notice.key)}</p>
        </div>
      ) : null}
      <Card title={t('card')} id="publish-now">
        <p>{t('intro')}</p>
        <p>{t('how')}</p>
        {busy ? <p class="callout" data-publish-busy>{t('busy')}</p> : null}
        {props.configured ? (
          <Form action="/publish">
            <FormActions>
              <Submit>{t('button')}</Submit>
            </FormActions>
          </Form>
        ) : null}
      </Card>
      {props.runs !== null ? (
        <Card title={t('history')} id="publish-history" actions={<a class="btn btn--secondary" href="/publish">{t('refresh')}</a>}>
          {lastDone?.state === 'failed' ? <p class="callout callout--danger">{t('failedNote')}</p> : null}
          <Table
            caption={t('history')}
            rows={runs}
            rowKey={(x) => x.id}
            empty={t('history.empty')}
            stack
            columns={[
              { key: 'date', header: t('col.date'), cell: (x) => <DateTime ms={x.createdAt} withTime /> },
              { key: 'origin', header: t('col.origin'), cell: (x) => t(`origin.${x.origin}`) },
              { key: 'state', header: t('col.state'), cell: (x) => <StatusBadge tone={TONE[x.state]} label={t(`state.${x.state}`)} /> },
            ]}
          />
        </Card>
      ) : null}
    </>
  );
}

async function render(c: Ctx, status: 200 | 409 | 502 | 503, notice?: Notice) {
  const token = publishToken(c.env);
  let runs: PipelineRun[] | null = null;
  let error: GithubError | null = null;
  if (token !== null) {
    const res = await listRuns(token);
    if (res.ok) runs = res.value;
    else error = res.error;
  }
  const shown: Notice | undefined = notice ?? (error !== null ? { tone: 'danger', key: `err.${error}` } : undefined);
  c.status(status);
  return c.render(<PublishPage configured={token !== null} runs={runs} notice={shown} />, { title: pm(c.var.lang)('title') });
}

r.get('/', requirePerm('publish.run'), async (c) => {
  const done = c.req.query('m') === 'requested';
  return render(c, 200, done ? { tone: 'success', key: 'requested' } : undefined);
});

r.post('/', requirePerm('publish.run'), async (c) => {
  const f = await parseForm(c, v.strictObject({}));
  if (!f.ok) return c.text('Bad Request', 400);
  const token = publishToken(c.env);
  if (token === null) {
    noAudit(c, 'publication not configured (no GitHub token): nothing requested');
    return render(c, 503, { tone: 'warning', key: 'off' });
  }
  // A run that has not started yet exports the catalogue when it starts: it already covers every change.
  const runs = await listRuns(token);
  if (!runs.ok) {
    noAudit(c, 'GitHub unavailable while checking the pipeline: nothing requested');
    return render(c, runs.error === 'auth' ? 503 : 502, { tone: 'danger', key: `err.${runs.error}` });
  }
  if (runs.value.some((x) => x.state === 'waiting')) {
    noAudit(c, 'a pipeline run is already waiting to start: nothing requested');
    return render(c, 409, { tone: 'warning', key: 'already' });
  }
  const sent = await dispatchPublish(token);
  if (!sent.ok) {
    noAudit(c, 'GitHub refused or did not answer the dispatch: nothing requested');
    return render(c, sent.error === 'auth' ? 503 : 502, { tone: 'danger', key: `err.${sent.error}` });
  }
  await withAudit(c, { action: 'publish.request', entity: 'publish_runs', entityId: null, before: null, after: { workflow: PUBLISH_WORKFLOW, ref: PUBLISH_REF, mode: 'publish' } });
  return c.redirect('/publish?m=requested', 303);
});

export default r;
