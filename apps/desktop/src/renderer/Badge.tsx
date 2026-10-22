import type { ReactNode } from 'react';

export function Badge(props: { tone: 'muted' | 'warn' | 'ok' | 'bad'; children: ReactNode; title?: string; testId?: string; value?: string }): React.JSX.Element {
  return (
    <span className={`badge ${props.tone}`} title={props.title} data-testid={props.testId} data-value={props.value}>
      {props.children}
    </span>
  );
}
