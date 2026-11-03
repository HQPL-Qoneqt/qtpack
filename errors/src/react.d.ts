import type { Component, ErrorInfo, ReactNode } from 'react';
import type { ErrorPayload } from './index.js';

export interface ErrorBoundaryProps {
  children?: ReactNode;
  // Shown after a render error. A function gets the error and a reset() that renders children again.
  fallback?: ReactNode | ((props: { error: unknown; reset: () => void }) => ReactNode);
  // Fields merged into the report, e.g. { error_type: 'CheckoutCrash' }.
  extra?: Partial<ErrorPayload>;
  onError?: (error: unknown, info: ErrorInfo) => void;
  onReset?: () => void;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, { hasError: boolean; error: unknown }> {
  reset(): void;
}

export { reportRenderError } from './index.js';
