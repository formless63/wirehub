/** The page header every route uses (plan 3.4): H1, count, the `(?)` for this page's docs, secondary actions and one primary. */

import { useRouter } from '@tanstack/react-router';
import { PageHeader, type PageHeaderProps } from '@wirehub/editor-react';
import type { JSX } from 'react';

import { HelpLink } from './HelpLink.tsx';

export function RouteHeader(props: Omit<PageHeaderProps, 'help'> & { help?: false }): JSX.Element {
  // a route renders inside the router; a test may render the page alone
  const router = useRouter({ warn: false }) as { state?: { location?: { pathname?: string } } } | undefined;
  const pathname = router?.state?.location?.pathname ?? (typeof window === 'undefined' ? '/' : window.location.pathname);
  const { help, ...rest } = props;
  return <PageHeader {...rest} {...(help === false ? {} : { help: <HelpLink pathname={pathname} /> })} />;
}
