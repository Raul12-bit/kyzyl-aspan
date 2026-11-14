import { isRouteErrorResponse, useRouteError } from 'react-router-dom';
import { useI18n } from '@/i18n';
import { ButtonLink, Icon } from '@/ui';

function Centered({ title, body }: { title: string; body?: string }) {
  const { m } = useI18n();
  return (
    <main
      id="main"
      className="mx-auto flex min-h-[70vh] max-w-xl flex-col items-center justify-center gap-4 px-[var(--el-gutter)] pt-[var(--el-header-h)] text-center"
    >
      <span className="grid h-12 w-12 place-items-center rounded-full border border-line text-amber">
        <Icon name="flame" />
      </span>
      <h1 className="m-0 text-h2 font-semibold tracking-[-0.02em]">{title}</h1>
      {body ? <p className="m-0 text-ink-muted">{body}</p> : null}
      <ButtonLink to="/" variant="primary" iconRight="arrowRight">
        {m.common.goHome}
      </ButtonLink>
    </main>
  );
}

export function NotFound() {
  const { m } = useI18n();
  return <Centered title={m.common.notFound} />;
}

export function RouteError() {
  const { m } = useI18n();
  const error = useRouteError();
  const detail = isRouteErrorResponse(error) ? `${error.status} ${error.statusText}` : error instanceof Error ? error.message : undefined;
  if (error) console.error(error);
  return <Centered title={m.common.errorTitle} body={detail} />;
}
