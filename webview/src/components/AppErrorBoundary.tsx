import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

type Props = {
  children: React.ReactNode;
};

type State = {
  error: Error | null;
};

export default class AppErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    if (!this.state.error) {
      return this.props.children;
    }

    return (
      <div className="app-error-state">
        <AlertTriangle size={28} />
        <h2>Project Assistant could not render</h2>
        <p>{this.state.error.message || 'An unexpected webview error occurred.'}</p>
        <button className="primary-btn" type="button" onClick={() => window.location.reload()}>
          <RefreshCw size={15} />
          Reload
        </button>
      </div>
    );
  }
}
