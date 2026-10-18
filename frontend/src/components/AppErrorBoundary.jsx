import { Component } from 'react';
import { useLanguage } from '../i18n/LanguageContext.jsx';

function AppErrorFallback({ onRetry }) {
  const { t } = useLanguage();
  return (
    <div className="app-error-fallback" role="alert">
      <div className="app-error-fallback-mark">!</div>
      <strong>{t('appError.title')}</strong>
      <span>{t('appError.body')}</span>
      <button type="button" className="gold-btn" onClick={onRetry}>
        {t('appError.retry')}
      </button>
    </div>
  );
}

// App-wide catch-all: any unexpected render error in a page (outside the
// map, which has its own MapErrorBoundary) lands here instead of an
// unstyled React error screen — sidebar/topbar stay mounted since this only
// wraps the routed page content, not the whole shell.
export default class AppErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
    this.handleRetry = this.handleRetry.bind(this);
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, info) {
    console.error('[Atlas] unhandled render error', error, info);
  }

  componentDidUpdate(prevProps) {
    // A route change while showing the fallback should give the new page a
    // fresh try rather than staying stuck on the old error.
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false });
    }
  }

  handleRetry() {
    this.setState({ hasError: false });
  }

  render() {
    if (this.state.hasError) {
      return <AppErrorFallback onRetry={this.handleRetry} />;
    }
    return this.props.children;
  }
}
