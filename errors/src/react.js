// ErrorBoundary for React and React Native. Reports through the client the
// platform entry created, so call init() from '@hqpl/errors' first.
//
//   import { ErrorBoundary } from '@hqpl/errors/react';
//   <ErrorBoundary fallback={({ error, reset }) => <Retry onPress={reset} />}>
//     <Screen />
//   </ErrorBoundary>

import { Component } from 'react';
import { reportRenderError } from './core.js';

export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
    this.reset = this.reset.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    reportRenderError(error, info, { level: 'error', ...(this.props.extra || {}) });
    try { this.props.onError?.(error, info); } catch { /* the app's hook must not break the boundary */ }
  }

  reset() {
    this.setState({ hasError: false, error: null });
    this.props.onReset?.();
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    const { fallback } = this.props;
    if (typeof fallback === 'function') return fallback({ error: this.state.error, reset: this.reset });
    return fallback ?? null;
  }
}

export { reportRenderError };
